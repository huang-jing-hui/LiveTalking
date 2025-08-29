import json
import time
import os

import aiohttp
import requests

from basereal import BaseReal
from logger import logger


def llm_response_v1(message, nerfreal: BaseReal):
    start = time.perf_counter()
    from openai import OpenAI
    client = OpenAI(
        # 如果您没有配置环境变量，请在此处用您的API Key进行替换
        api_key=os.getenv("AI_MOTA_API_KEY"),
        # 填写DashScope SDK的base_url
        base_url="https://api-inference.modelscope.cn/v1",
    )
    end = time.perf_counter()
    logger.info(f"llm Time init: {end - start}s")
    completion = client.chat.completions.create(
        model="qwen-plus",
        messages=[{'role': 'system', 'content': '你是黄小辉的'},
                  {'role': 'user', 'content': message}],
        stream=True,
        # 通过以下设置，在流式输出的最后一行展示token使用信息
        stream_options={"include_usage": True}
    )
    result = ""
    first = True
    for chunk in completion:
        if len(chunk.choices) > 0:
            # print(chunk.choices[0].delta.content)
            if first:
                end = time.perf_counter()
                logger.info(f"llm Time to first chunk: {end - start}s")
                first = False
            msg = chunk.choices[0].delta.content
            lastpos = 0
            # msglist = re.split('[,.!;:，。！?]',msg)
            for i, char in enumerate(msg):
                if char in ",.!;:，。！？：；":
                    result = result + msg[lastpos:i + 1]
                    lastpos = i + 1
                    if len(result) > 10:
                        logger.info(result)
                        nerfreal.put_msg_txt(result)
                        result = ""
            result = result + msg[lastpos:]
    end = time.perf_counter()
    logger.info(f"llm Time to last chunk: {end - start}s")
    nerfreal.put_msg_txt(result)


url_stream = "http://127.0.0.1:9001/api/group/voiceAssistant"
headers_stream = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream'
}


# --- 转换后的同步函数 ---
def llm_response(message, nerfreal: BaseReal):
    """
    使用 requests 库发送同步流式 POST 请求并处理响应。
    """
    start = time.perf_counter()
    data = {
        "text": message
    }
    result = ""
    first = True

    try:
        # 关键改动 1: 使用 requests.post 并设置 stream=True
        with requests.post(url_stream, json=data, headers=headers_stream, stream=True, timeout=300) as response:

            # 检查 HTTP 错误 (例如 404, 500)
            response.raise_for_status()

            # 关键改动 2: 使用 iter_lines() 迭代流式响应的每一行
            for line in response.iter_lines():
                if line:
                    decoded_line = line.decode('utf-8').strip()

                    # --- 内部处理逻辑保持不变 ---
                    if decoded_line.startswith('data:'):
                        # 移除 'data:' 前缀
                        json_data_str = decoded_line[5:].strip()
                        if not json_data_str:
                            continue

                        if first:
                            end = time.perf_counter()
                            logger.info(f"llm Time to first chunk: {end - start:.4f}s")
                            first = False

                        try:
                            data_result = json.loads(json_data_str)
                            print(f"收到数据: {data_result}")  # 调试打印
                            msg = data_result.get('content', '')  # 使用 .get() 更安全

                            if msg:
                                lastpos = 0
                                # re.split('[,.!;:，。！?]'...) 的逻辑也可以用这种方式实现
                                for i, char in enumerate(msg):
                                    if char in ",.!;:，。！？：；":
                                        # 拼接当前句子片段
                                        sentence_part = msg[lastpos:i + 1]
                                        result = result + sentence_part
                                        lastpos = i + 1

                                        # 当累积的文本足够长时，发送给 NeRF
                                        if len(result) > 10:
                                            logger.info(f"Sending sentence chunk: {result}")
                                            nerfreal.put_msg_txt(result)
                                            result = ""

                                # 将剩余的文本（最后一个标点之后的部分）添加到 result 中
                                result = result + msg[lastpos:]

                        except json.JSONDecodeError:
                            logger.warning(f"Could not decode JSON from line: {json_data_str}")
                            continue

            # 循环结束后，处理可能剩余在 result 缓冲区的文本
            if result:
                logger.info(f"Sending final chunk: {result}")
                nerfreal.put_msg_txt(result)

            end = time.perf_counter()
            logger.info(f"llm Time to last chunk: {end - start:.4f}s")

    except requests.exceptions.RequestException as e:
        logger.error(f"An error occurred during the request: {e}")
