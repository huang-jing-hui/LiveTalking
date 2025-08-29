$(document).ready(function () {
    // --- 全局状态变量 ---
    let sdk = null;
    let currentInputMode = 'none';

    // 通话相关
    let isCallActive = false;
    let ws = null;
    let audioContext = null;
    let processor = null;
    let mediaStream = null;
    let isServerReady = false;
    let isDigitalHumanSpeaking = false;

    // --- 新增：截图相关变量 ---
    let frameCaptureInterval = null; // 用于存放 setInterval 的 ID
    let capturedFrames = []; // 存放截图 Base64 数据的数组
    let canvasContext = null; // 用于绘图的 canvas 上下文

    // --- DOM 元素缓存 ---
    const $videoPlayer = $('#rtc_media_player');
    const $localVideoPlayer = $('#local_video_player');
    const $localVideoContainer = $('#local-video-container');
    const $btnPlay = $('#btn_play');
    const $btnStop = $('#stop');
    const $voiceRecordBtn = $('#voice-record-btn');
    const $voiceCallBtn = $('#voice-call-btn');
    const $videoCallBtn = $('#video-call-btn');
    const $chatMessageInput = $('#chat-message');
    const $sessionidInput = $('#sessionid');

    // --- UI 更新函数 ---
    function updateConnectionStatus(status) {
        const $statusIndicator = $('#connection-status');
        const $statusText = $('#status-text');
        $statusIndicator.removeClass('status-connected status-disconnected status-connecting');
        switch (status) {
            case 'connected':
                $statusIndicator.addClass('status-connected');
                $statusText.text('已连接');
                break;
            case 'connecting':
                $statusIndicator.addClass('status-connecting');
                $statusText.text('连接中...');
                break;
            case 'disconnected':
            default:
                $statusIndicator.addClass('status-disconnected');
                $statusText.text('未连接');
                break;
        }
    }

    function addChatMessage(message, type = 'user') {
        const messagesContainer = $('#chat-messages');
        const messageClass = type === 'user' ? 'user-message' : 'system-message';
        const sender = type === 'user' ? '您' : '数字人';
        const messageElement = $(`<div class="asr-text ${messageClass}">${sender}: ${message}</div>`);
        messagesContainer.append(messageElement);
        messagesContainer.scrollTop(messagesContainer[0].scrollHeight);
    }

    // --- 核心功能：状态管理 ---
    function updateInputMode(newMode) {
        currentInputMode = newMode;

        // 根据新模式更新所有输入按钮的启用/禁用状态
        $voiceRecordBtn.toggleClass('disabled-input', newMode !== 'none' && newMode !== 'pushToTalk');
        $voiceCallBtn.toggleClass('disabled-input', newMode !== 'none' && newMode !== 'voiceCall');
        $videoCallBtn.toggleClass('disabled-input', newMode !== 'none' && newMode !== 'videoCall');

        // 如果是通话模式，禁用文本输入框
        $('#chat-form button, #chat-form textarea').prop('disabled', newMode === 'voiceCall' || newMode === 'videoCall');
    }

    // --- SRS WebRTC 播放 ---
    function startPlay() {
        updateConnectionStatus('connecting');
        if (sdk) sdk.close();
        sdk = new SrsRtcWhipWhepAsync();
        $videoPlayer.prop('srcObject', sdk.stream);
        const url = `http://${window.location.hostname}:1985/rtc/v1/whep/?app=live&stream=livestream`;
        sdk.play(url).then(session => {
            console.log('WebRTC播放已启动，会话ID:', session.sessionid);
            updateConnectionStatus('connected');
            $btnPlay.hide();
            $btnStop.show();
        }).catch(reason => {
            sdk.close();
            updateConnectionStatus('disconnected');
            console.error('WebRTC播放失败:', reason);
        });
    }

    function stopPlay() {
        if (sdk) sdk.close();
        updateConnectionStatus('disconnected');
        $btnStop.hide();
        $btnPlay.show();
    }

    // --- 核心修改：sendHumanRequest 现在发送图片列表 ---
    function sendHumanRequest(text, imageFrames = []) { // 第二个参数从 videoBlob 变为 imageFrames
        addChatMessage(text, 'user');
        const sessionid = parseInt($sessionidInput.val());

        const payload = {
            text,
            type: 'chat',
            interrupt: true,
            sessionid,
            images: imageFrames // 新增 images 字段
        };

        const fetchOptions = {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        };

        if (imageFrames.length > 0) {
            console.log(`Sending chat message with ${imageFrames.length} captured frames.`);
        } else {
            console.log('Sending chat message (text only):', text);
        }

        fetch('/human', fetchOptions).catch(error => console.error('发送 /human 请求失败:', error));
    }

    // --- 按住说话 (Push-to-Talk) ---
    let recognition;
    const isSpeechRecognitionSupported = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
    if (isSpeechRecognitionSupported) {
        recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'zh-CN';
        recognition.onresult = event => {
            let interim = '', final = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                event.results[i].isFinal ? final += event.results[i][0].transcript : interim += event.results[i][0].transcript;
            }
            $chatMessageInput.val(interim || final);
        };
        recognition.onerror = event => console.error('语音识别错误:', event.error);
    }

    function startVoiceRecording() {
        if (currentInputMode !== 'none') return;
        updateInputMode('pushToTalk');
        $voiceRecordBtn.addClass('recording-pulse').css('background-color', '#dc3545');
        if (recognition) recognition.start();
    }

    function stopVoiceRecording() {
        if (currentInputMode !== 'pushToTalk') return;
        $voiceRecordBtn.removeClass('recording-pulse').css('background-color', '');
        if (recognition) recognition.stop();
        setTimeout(() => {
            const recognizedText = $chatMessageInput.val().trim();
            if (recognizedText) {
                sendHumanRequest(recognizedText);
                $chatMessageInput.val('');
            }
            updateInputMode('none');
        }, 300);
    }


    // --- 语音/视频通话 ---
    function startCall(callType) {
        if (isCallActive) return;

        isCallActive = true;
        updateInputMode(callType === 'voice' ? 'voiceCall' : 'videoCall');

        const $btn = callType === 'voice' ? $voiceCallBtn : $videoCallBtn;
        const $label = $(`#${callType}-call-label`);
        $btn.addClass('calling');
        $label.text('通话中...');

        if (callType === 'video') {
            $localVideoContainer.show();
            // --- 新增：为截图准备 canvas ---
            const canvas = document.createElement('canvas');
            canvasContext = canvas.getContext('2d');
        }

        initWebSocket();

        const constraints = {
            audio: {sampleRate: 16000, channelCount: 1, noiseSuppression: true, echoCancellation: true},
            video: callType === 'video'
        };

        navigator.mediaDevices.getUserMedia(constraints)
            .then(stream => {
                mediaStream = stream;
                if (callType === 'video') {
                    $localVideoPlayer.prop('srcObject', stream);
                    // --- 新增：设置 canvas 尺寸以匹配视频 ---
                    $localVideoPlayer.on('loadedmetadata', () => {
                        canvasContext.canvas.width = $localVideoPlayer[0].videoWidth;
                        canvasContext.canvas.height = $localVideoPlayer[0].videoHeight;
                    });
                }
                audioContext = new (window.AudioContext || window.webkitAudioContext)({sampleRate: 16000});
                return audioContext.state === 'suspended' ? audioContext.resume().then(() => stream) : stream;
            })
            .then(stream => {
                const source = audioContext.createMediaStreamSource(stream);
                processor = audioContext.createScriptProcessor(2048, 1, 1);
                processor.onaudioprocess = async (event) => {
                    if (!isCallActive || isDigitalHumanSpeaking) return;
                    const audioData = convertAudioData(event.inputBuffer);
                    if (isServerReady && ws?.readyState === WebSocket.OPEN) {
                        try {
                            ws.send(audioData);
                        } catch (e) {
                            console.error('发送音频数据失败:', e);
                        }
                    }
                };
                source.connect(processor);
                processor.connect(audioContext.destination);
            })
            .catch(error => {
                console.error(`${callType} 通话启动失败:`, error);
                addChatMessage(`${callType} 通话启动失败: ${error.message}`, 'system');
                stopCall();
            });
    }

    function stopCall() {
        if (!isCallActive) return;

        // --- 新增：确保定时器在通话结束时停止 ---
        if (frameCaptureInterval) {
            clearInterval(frameCaptureInterval);
            frameCaptureInterval = null;
        }

        isCallActive = false;

        $voiceCallBtn.removeClass('calling');
        $videoCallBtn.removeClass('calling');
        $('#voice-call-label').text('语音通话');
        $('#video-call-label').text('视频通话');
        $localVideoContainer.hide();
        $localVideoPlayer.prop('srcObject', null);

        if (ws?.readyState === WebSocket.OPEN) {
            try {
                ws.send('stop');
            } catch (e) {
                console.error('发送停止指令失败:', e);
            }
        }

        cleanupCallResources();
        updateInputMode('none');
    }

    function initWebSocket() {
        const wsUrl = `ws://${window.location.hostname}:8765/ws`;
        try {
            ws = new WebSocket(wsUrl);
            ws.binaryType = 'arraybuffer';
             ws.onopen = () => {
                console.log('WebSocket 连接已建立');
                addChatMessage('语音服务已连接', 'system');
                //ws.send(`start-${parseInt($sessionidInput.val())}`);
                ws.send(`start`);
            };
            ws.onmessage = async (event) => {
                try {
                    if (typeof event.data === 'string') {
                        const data = JSON.parse(event.data);
                        switch (data.type) {
                            case 'started':
                                isServerReady = true;
                                console.log('语音服务器准备就绪');
                                break;

                            // --- 核心修改： 'underway' 开始截图 ---
                            case 'underway':
                                console.log('用户开始说话...');
                                if (currentInputMode === 'videoCall' && !frameCaptureInterval) {
                                    capturedFrames = []; // 清空上一轮的截图
                                    frameCaptureInterval = setInterval(() => {
                                        if ($localVideoPlayer[0].readyState >= 2) { // 确保视频有数据
                                            // 将当前视频帧绘制到 canvas
                                            canvasContext.drawImage($localVideoPlayer[0], 0, 0, canvasContext.canvas.width, canvasContext.canvas.height);
                                            // 从 canvas 获取 base64 编码的 JPG 图像，并添加到数组
                                            const frameDataUrl = canvasContext.canvas.toDataURL('image/jpeg', 0.8); // 0.8 是质量参数
                                            capturedFrames.push(frameDataUrl);
                                            console.log(`截取了第 ${capturedFrames.length} 帧`);
                                        }
                                    }, 1000); // 每 1000 毫秒 (1秒) 截一帧
                                }
                                break;

                            // --- 核心修改：'complete' 停止截图并发送 ---
                            case 'complete':
                                console.log('收到识别结果:', data.text);

                                // 停止截图定时器
                                if (frameCaptureInterval) {
                                    clearInterval(frameCaptureInterval);
                                    frameCaptureInterval = null;
                                    console.log(`截图结束，共截取 ${capturedFrames.length} 帧`);
                                }

                                if (!data || !data.text || isDigitalHumanSpeaking) {
                                    capturedFrames = []; // 如果文本无效，也清空截图
                                    return;
                                }

                                const recognizedText = data.text;

                                // 发送文本和已捕获的截图数组
                                sendHumanRequest(recognizedText, capturedFrames);
                                capturedFrames = []; // 发送后清空

                                isDigitalHumanSpeaking = true;
                                if (await waitForDigitalHumanToStartSpeaking()) {
                                    await waitForDigitalHumanToStopSpeaking();
                                }
                                isDigitalHumanSpeaking = false;
                                break;
                            case 'error':
                                console.error('语音服务错误:', data.message);
                                addChatMessage('语音服务错误: ' + data.message, 'system');
                                break;
                        }
                    }
                } catch (e) {
                    console.error('解析WebSocket消息失败:', e);
                }
            };
            ws.onerror = error => {
                console.error('WebSocket 错误:', error);
                addChatMessage('通话连接错误', 'system');
                stopCall();
            };
            ws.onclose = () => {
                console.log('WebSocket 连接已关闭');
                if (isCallActive) {
                    addChatMessage('通话已断开', 'system');
                    stopCall();
                }
            };
        } catch (e) {
            console.error('创建WebSocket连接失败:', e);
            addChatMessage('无法连接到通话服务', 'system');
            stopCall();
        }
    }

    function cleanupCallResources() {
        // --- 新增：清理 canvas 上下文 ---
        canvasContext = null;

        processor?.disconnect();
        mediaStream?.getTracks().forEach(track => track.stop());
        audioContext?.close().catch(console.error);
        ws?.close();

        processor = mediaStream = audioContext = ws = null;
        isServerReady = isDigitalHumanSpeaking = false;
    }

    // --- 辅助函数 ---
    function convertAudioData(inputBuffer) {
        const inputData = inputBuffer.getChannelData(0);
        const output = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
            const amplified = inputData[i] * 1.5;
            const clamped = Math.max(-1, Math.min(1, amplified));
            output[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
        }
        return output.buffer;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // 检查数字人是否正在讲话的函数
    async function is_speaking() {
        // 这里应该调用实际的API来检查数字人是否正在讲话
        // 暂时返回false，你需要根据实际的API来实现
        try {
            const response = await fetch('/is_speaking', {
                body: JSON.stringify({
                    sessionid: parseInt(document.getElementById('sessionid').value),
                }),
                headers: {
                    'Content-Type': 'application/json'
                },
                method: 'POST'
            })
            const data = await response.json();
            console.log('is_speaking res:', data)
            return data.data
        } catch (error) {
            console.error('检查数字人讲话状态失败:', error);
            return false;
        }
    }

    // 等待数字人开始讲话
    async function waitForDigitalHumanToStartSpeaking() {
        for (let i = 0; i < 20; i++) {  // 等待数字人开始讲话，最长等待20s
            const bspeak = await is_speaking();
            if (bspeak) {
                return true;
            }
            await sleep(1000);
        }
        return false;
    }

    // 等待数字人讲话结束
    async function waitForDigitalHumanToStopSpeaking() {
        while (true) {  // 等待数字人讲话结束
            const bspeak = await is_speaking();
            if (!bspeak) {
                break;
            }
            await sleep(1000);
        }
        await sleep(2000); // 额外等待2秒
    }

    // --- 事件绑定 ---
    $btnPlay.click(startPlay);
    $btnStop.click(stopPlay);
    $('#video-size-slider').on('input', function () {
        const value = $(this).val();
        $('#video-size-value').text(value + '%');
        $videoPlayer.css('width', value + '%');
    });
    $('#chat-form').on('submit', e => {
        e.preventDefault();
        const message = $chatMessageInput.val();
        if (!message.trim()) return;
        sendHumanRequest(message);
        $chatMessageInput.val('');
    });
    $voiceRecordBtn.on('mousedown touchstart', e => {
        e.preventDefault();
        startVoiceRecording();
    })
        .on('mouseup mouseleave touchend', () => stopVoiceRecording());

    $voiceCallBtn.on('click', () => isCallActive ? stopCall() : startCall('voice'));
    $videoCallBtn.on('click', () => isCallActive ? stopCall() : startCall('video'));

    $(window).on('beforeunload', () => {
        if (isCallActive) stopCall();
    });
});