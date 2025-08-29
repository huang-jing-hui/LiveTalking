from typing import List

import requests
import json
import time
import logging

from basereal import BaseReal

logger = logging.getLogger(__name__)

# --- 配置 ---
# 请将这些 URL 和 Headers 替换为您实际的配置


# 新增：LLM 视频流式接口
url_video_stream = "http://127.0.0.1:9001/api/group/videoAssistant"
# 注意：发送 multipart/form-data 时，requests 会自动设置 Content-Type，
# 我们只需要设置我们期望接收的类型。
headers_video_stream = {
    'Accept': 'text/event-stream'
}


# --- 新增的函数 ---
def llm_response_with_video(message, video_data_bytes: bytes, nerfreal: BaseReal):
    """
    发送包含视频和文本的同步流式 POST 请求，并处理响应。
    """
    start = time.perf_counter()
    result = ""
    first = True

    # 关键改动 1: 构造 multipart/form-data 请求体
    # 'data' 部分用于存放普通的表单字段，对应 @RequestParam("text")
    data_payload = {
        'text': message
    }

    # 'files' 部分用于存放文件，对应 @RequestParam(value = "videoFile")
    # 格式为: {<field_name>: (<filename>, <file_data>, <content_type>)}
    files_payload = {
        'videoFile': ('user_video.webm', video_data_bytes, 'video/webm')
    }

    try:
        # 关键改动 2: 使用 requests.post 并传入 data 和 files 参数
        # requests 库会自动处理 multipart/form-data 的编码和 Content-Type header
        with requests.post(
                url_video_stream,
                data=data_payload,
                files=files_payload,
                headers=headers_video_stream,
                stream=True,
                timeout=300
        ) as response:

            # 检查 HTTP 错误 (例如 404, 500)
            response.raise_for_status()

            # 关键改动 3: 响应处理逻辑与 llm_response 完全相同，因为服务端返回的都是 text/event-stream
            for line in response.iter_lines():
                if line:
                    decoded_line = line.decode('utf-8').strip()

                    # --- 内部处理逻辑保持不变 ---
                    if decoded_line.startswith('data:'):
                        json_data_str = decoded_line[5:].strip()
                        if not json_data_str:
                            continue

                        if first:
                            end = time.perf_counter()
                            # 更新日志信息以区分
                            logger.info(f"llm_video Time to first chunk: {end - start:.4f}s")
                            first = False

                        try:
                            data_result = json.loads(json_data_str)
                            print(f"收到视频LLM数据: {data_result}")  # 调试打印
                            msg = data_result.get('content', '')

                            if msg:
                                # 这里的句子切分和发送逻辑与 llm_response 保持一致
                                lastpos = 0
                                for i, char in enumerate(msg):
                                    if char in ",.!;:，。！？：；":
                                        sentence_part = msg[lastpos:i + 1]
                                        result = result + sentence_part
                                        lastpos = i + 1
                                        if len(result) > 10:
                                            logger.info(f"Sending sentence chunk from video LLM: {result}")
                                            nerfreal.put_msg_txt(result)
                                            result = ""
                                result = result + msg[lastpos:]

                        except json.JSONDecodeError:
                            logger.warning(f"Could not decode JSON from line: {json_data_str}")
                            continue

            # 循环结束后，处理可能剩余在 result 缓冲区的文本
            if result:
                logger.info(f"Sending final chunk from video LLM: {result}")
                nerfreal.put_msg_txt(result)

            end = time.perf_counter()
            logger.info(f"llm_video Time to last chunk: {end - start:.4f}s")

    except requests.exceptions.RequestException as e:
        logger.error(f"An error occurred during the video assistant request: {e}")


# 假设新的 LLM 接口地址
url_image_stream = "http://127.0.0.1:9001/api/group/videoAssistantBase64"
# 新接口接收 JSON，返回 event-stream
headers_image_stream = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream'
}


# --- 新的函数：llm_response_with_images ---
def llm_response_with_images(message: str, images_base64: List[str], nerfreal: BaseReal):
    """
    发送包含图片列表和文本的同步流式 POST 请求，并处理响应。
    """
    start = time.perf_counter()
    result = ""
    first = True

    # 关键改动 1: 构造 JSON 请求体
    data_payload = {
        'text': message,
        'images': images_base64  # 将图片 Base64 列表放入 payload
    }

    try:
        # 关键改动 2: 使用 requests.post 并传入 json 参数
        with requests.post(
                url_image_stream,
                json=data_payload,  # 发送 JSON 而不是 multipart
                headers=headers_image_stream,
                stream=True,
                timeout=300
        ) as response:

            response.raise_for_status()

            # 响应处理逻辑与之前完全相同
            for line in response.iter_lines():
                if line:
                    decoded_line = line.decode('utf-8').strip()
                    if decoded_line.startswith('data:'):
                        json_data_str = decoded_line[5:].strip()
                        if not json_data_str:
                            continue
                        if first:
                            end = time.perf_counter()
                            logger.info(f"llm_images Time to first chunk: {end - start:.4f}s")
                            first = False
                        try:
                            data_result = json.loads(json_data_str)
                            msg = data_result.get('content', '')
                            if msg:
                                # 句子切分和发送逻辑保持不变
                                lastpos = 0
                                for i, char in enumerate(msg):
                                    if char in ",.!;:，。！？：；":
                                        sentence_part = msg[lastpos:i + 1]
                                        result += sentence_part
                                        lastpos = i + 1
                                        if len(result) > 10:
                                            nerfreal.put_msg_txt(result)
                                            result = ""
                                result += msg[lastpos:]
                        except json.JSONDecodeError:
                            logger.warning(f"Could not decode JSON from line: {json_data_str}")

            if result:
                nerfreal.put_msg_txt(result)

            end = time.perf_counter()
            logger.info(f"llm_images Time to last chunk: {end - start:.4f}s")

    except requests.exceptions.RequestException as e:
        logger.error(f"An error occurred during the image assistant request: {e}")
