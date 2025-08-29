import json
import queue
import threading
import asyncio
import numpy as np
import websockets
import time
from funasr import AutoModel
from websockets import WebSocketServerProtocol

# 模型配置
chunk_size = [0, 8, 4]  # [0, 10, 5] 600ms, [0, 8, 4] 480ms
encoder_chunk_look_back = 4  # number of chunks to lookback for encoder self-attention
decoder_chunk_look_back = 1  # number of encoder chunks to lookback for decoder cross-attention

# 加载模型
print("正在加载模型...")
model = AutoModel(model="G:\\models\\stt\\speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online",
                  model_revision="v2.0.4",
                  disable_update=True
                  )
print("模型加载完成！")

# 音频配置
sample_rate = 16000  # FunASR通常使用16kHz采样率
chunk_stride = chunk_size[1] * 960  # 600ms对应的样本数


class ClientSession:
    def __init__(self, websocket, loop):
        self.websocket = websocket
        self.audio_queue = queue.Queue()
        self.cache = {}
        self.buffer = np.array([], dtype=np.float32)
        self.active = True
        self.chunk_count = 0
        self.loop = loop  # 保存事件循环
        self.send_queue = queue.Queue()  # 用于线程安全的发送队列

        # 语音识别缓存相关状态
        self.recognition_buffer = ""  # 当前累积的识别结果
        self.last_activity_time = time.time()  # 最后收到新词的时间
        self.silence_timeout = 1  # 静音超时时间（秒），用于判断句子结束
        self.min_sentence_length = 1  # 最小句子长度，避免误触发
        self.awaken = False  # 唤醒状态

        # 音频活动检测
        self.last_audio_time = time.time()
        self.audio_silence_threshold = 0.01  # 音频静音阈值
        self.consecutive_silence_chunks = 0
        self.max_silence_chunks = 3  # 连续静音块数阈值

    def add_audio(self, audio_data):
        self.audio_queue.put(audio_data)

    def add_message(self, message):
        """添加消息到发送队列"""
        self.send_queue.put(message)
        self.recognition_buffer = ""

    def is_audio_silent(self, audio_chunk):
        """检测音频是否为静音"""
        if len(audio_chunk) == 0:
            return True
        # 计算音频的RMS能量
        rms = np.sqrt(np.mean(audio_chunk ** 2))
        return rms < self.audio_silence_threshold

    def update_recognition_result(self, new_text):
        """更新识别结果，处理累积文本"""
        if not new_text:
            return
        if not self.recognition_buffer:
            self.add_message(json.dumps({
                'type': "underway",
            }))
        self.recognition_buffer += new_text

        # # 移除可能的重复内容
        # new_text = new_text.strip()
        # if not new_text:
        #     return
        #
        # # 如果新文本完全包含在当前缓存中，则跳过
        # if new_text in self.recognition_buffer:
        #     return
        #
        # # 如果当前缓存包含在新文本中，替换整个缓存
        # if self.recognition_buffer in new_text:
        #     self.recognition_buffer = new_text
        # else:
        #     # 否则直接替换为新文本
        #     self.recognition_buffer = new_text

        self.last_activity_time = time.time()
        print(f"[累积] 当前文本: '{self.recognition_buffer}'")

    def _should_end_sentence(self, text):
        """判断是否应该结束当前句子"""
        if not text or len(text) < self.min_sentence_length:
            return False

        # 检查是否包含结束标点
        end_punctuations = ("。", "！", "？", ".", "!", "?")
        return any(punct in text for punct in end_punctuations)

    def check_sentence_completion(self):

        """检查句子是否应该完成（基于时间超时）"""
        current_time = time.time()

        # 如果有累积的文本且超过静音超时时间
        if (self.recognition_buffer and
                current_time - self.last_activity_time > self.silence_timeout and
                len(self.recognition_buffer) >= self.min_sentence_length):
            print(f"[超时] 处理完整句子: '{self.recognition_buffer}'")
            self._process_complete_sentence(self.recognition_buffer)
            self.recognition_buffer = ""

    def force_sentence_completion(self, force=False):
        """强制完成当前句子（用于流结束时）"""
        if self.recognition_buffer and (force or len(self.recognition_buffer) >= self.min_sentence_length):
            print(f"[强制] 处理完整句子: '{self.recognition_buffer}'")
            self._process_complete_sentence(self.recognition_buffer)
            self.recognition_buffer = ""

    def _process_complete_sentence(self, sentence):
        """处理完整的句子，进行指令匹配并发送"""
        if not sentence or len(sentence) < self.min_sentence_length:
            return

        sentence = sentence.strip()
        final_res = model.generate(
            input=np.array([]),  # 空的音频块
            cache=self.cache,
            is_final=True,  # 标记为最终块
            chunk_size=chunk_size,
            encoder_chunk_look_back=encoder_chunk_look_back,
            decoder_chunk_look_back=decoder_chunk_look_back
        )
        if final_res and len(final_res[0]['text'].strip()) > 0:
            print(f"[FINAL] {final_res[0]['text']}")
            sentence += final_res[0]['text']
        result = {
            "type": "complete",
            "text": sentence,
            "complete": True,
            "chunk": self.chunk_count,
        }

        self.add_message(json.dumps(result))
        print(f"[COMPLETE] 发送完整句子: '{sentence}'")

    async def send_messages(self):
        """从发送队列取出消息并发送"""
        while self.active or not self.send_queue.empty():
            try:
                message = self.send_queue.get(timeout=0.1)
                await self.websocket.send(message)
            except queue.Empty:
                await asyncio.sleep(0.01)
            except Exception as e:
                print(f"发送消息出错: {e}")
                break
        # 任务退出前兜底发送最后缓存
        if self.recognition_buffer:
            self._process_complete_sentence(self.recognition_buffer)
            self.recognition_buffer = ""

    def stop(self):
        self.active = False
        # 放入空数据唤醒处理线程
        self.audio_queue.put(np.array([], dtype=np.float32))


def process_audio(session: ClientSession):
    """处理音频数据的线程函数"""
    print(f"开始处理客户端音频数据...")

    while session.active:
        try:

            # 从队列获取音频数据
            audio_chunk = session.audio_queue.get(timeout=0.5)

            # 如果收到空数据表示结束
            if audio_chunk.size == 0:
                break

            # 检测音频是否为静音
            is_silent = session.is_audio_silent(audio_chunk)
            if is_silent:
                session.consecutive_silence_chunks += 1
            else:
                session.consecutive_silence_chunks = 0
                session.last_audio_time = time.time()

            # 将新数据添加到缓冲区
            session.buffer = np.concatenate([session.buffer, audio_chunk])

            # 当缓冲区有足够数据时进行识别
            while len(session.buffer) >= chunk_stride:
                # 提取一个chunk用于识别
                speech_chunk = session.buffer[:chunk_stride]
                session.buffer = session.buffer[chunk_stride:]  # 移除已处理的数据

                # 进行语音识别
                try:
                    res = model.generate(
                        input=speech_chunk,
                        cache=session.cache,
                        is_final=False,  # 流式处理，通常不是最终块
                        chunk_size=chunk_size,
                        encoder_chunk_look_back=encoder_chunk_look_back,
                        decoder_chunk_look_back=decoder_chunk_look_back
                    )

                    # 处理识别结果
                    if res and res[0]['text']:
                        text = res[0]['text'].strip()
                        if text:
                            session.update_recognition_result(text)

                    session.chunk_count += 1

                except Exception as e:
                    print(f"识别出错: {e}")
                    session.add_message(json.dumps({"error": str(e)}))

            # 检查句子是否应该完成
            session.check_sentence_completion()

        except queue.Empty:
            # 超时时检查句子完成
            session.check_sentence_completion()
            continue
        except Exception as e:
            print(f"处理线程异常: {e}")
            session.add_message(json.dumps({"error": f"处理线程异常: {e}"}))
            break

    print(f"客户端处理线程结束")

    # 处理剩余的音频（最终部分）
    if len(session.buffer) > 0:
        try:
            res = model.generate(
                input=session.buffer,
                cache=session.cache,
                is_final=True,
                chunk_size=chunk_size
            )
            if res and res[0]['text']:
                final_text = res[0]['text'].strip()
                if final_text:
                    session.update_recognition_result(final_text)
        except Exception as e:
            print(f"最终识别出错: {e}")

    # 强制处理剩余的句子
    session.force_sentence_completion()


async def audio_websocket_handler(websocket: WebSocketServerProtocol):
    """WebSocket处理函数"""
    print(f"客户端连接: {websocket.remote_address}")
    loop = asyncio.get_event_loop()
    session = ClientSession(websocket, loop)

    # 启动处理线程
    processing_thread = threading.Thread(target=process_audio, args=(session,))
    processing_thread.daemon = True
    processing_thread.start()

    # 启动消息发送任务
    send_task = asyncio.create_task(session.send_messages())

    try:
        async for message in websocket:
            # 接收二进制音频数据
            if isinstance(message, bytes):
                try:
                    # 直接将字节数据转换为numpy数组（假设是16位PCM数据）
                    # 将字节数据转换为int16数组，然后归一化为float32范围[-1, 1]
                    int16_array = np.frombuffer(message, dtype=np.int16)
                    audio_data = int16_array.astype(np.float32) / 32768.0
                    session.add_audio(audio_data)
                except Exception as e:
                    print(f"音频处理错误: {e}")
                    await websocket.send(json.dumps({"error": f"音频处理错误: {e}"}))

            # 处理文本命令
            elif isinstance(message, str):
                if message == "stop":  # End Of Stream
                    print("收到流结束信号")
                    session.stop()
                    # 等待处理线程结束
                    processing_thread.join(timeout=2.0)
                    # 确保发送最终结果
                    session.force_sentence_completion(force=True)
                    await websocket.send(json.dumps({'type': 'stopped'}))
                    break
                elif message == "start":
                    await websocket.send(json.dumps({'type': 'started'}))

    except websockets.exceptions.ConnectionClosed:
        print("客户端断开连接")
    finally:
        session.stop()
        # 等待处理线程结束
        processing_thread.join(timeout=2.0)
        session.force_sentence_completion(force=True)
        # 取消发送任务
        send_task.cancel()
        try:
            await send_task
        except asyncio.CancelledError:
            pass
        print(f"清理客户端资源: {websocket.remote_address}")


async def start_server():
    """启动WebSocket服务器"""
    print(f"启动WebSocket服务器，端口: 8765")
    print(f"等待客户端连接...")
    async with websockets.serve(audio_websocket_handler, "0.0.0.0", 8765):
        await asyncio.Future()  # 永久运行


if __name__ == "__main__":
    asyncio.run(start_server())
