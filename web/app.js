$(document).ready(function () {
    // --- 全局状态变量 ---
    let sdk = null; // SRS SDK 实例
    let currentInputMode = 'none'; // 'none', 'pushToTalk', 'voiceCall', 'videoCall'

    // 语音/视频通话相关
    let isCallActive = false;
    let ws = null;
    let audioContext = null;
    let processor = null;
    let mediaStream = null;
    let isServerReady = false;
    let isDigitalHumanSpeaking = false;

    // 视频录制相关
    let videoRecorder = null;
    let videoChunks = [];

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

    // --- 文本聊天与朗读 ---
    function sendHumanRequest(text, videoBlob = null) {
        addChatMessage(text, 'user');

        const sessionid = parseInt($sessionidInput.val());
        let fetchOptions;

        if (videoBlob) {
            // 如果有视频，使用 FormData
            const formData = new FormData();
            formData.append('text', text);
            formData.append('video', videoBlob, 'user_video.webm');
            formData.append('type', 'chat');
            formData.append('interrupt', true);
            formData.append('sessionid', sessionid);

            fetchOptions = {
                method: 'POST',
                body: formData
                // 注意：使用 FormData 时不要手动设置 Content-Type header
            };
            console.log('Sending chat message with video.');

        } else {
            // 否则，使用 JSON
            fetchOptions = {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({text, type: 'chat', interrupt: true, sessionid})
            };
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
    function startCall(callType) { // callType: 'voice' or 'video'
        if (isCallActive) return;

        isCallActive = true;
        updateInputMode(callType === 'voice' ? 'voiceCall' : 'videoCall');

        const $btn = callType === 'voice' ? $voiceCallBtn : $videoCallBtn;
        const $label = $(`#${callType}-call-label`);
        $btn.addClass('calling');
        $label.text('通话中...');

        if (callType === 'video') {
            $localVideoContainer.show();
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

        if (videoRecorder?.state === 'recording') {
            videoRecorder.stop();
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
                    console.log('WebSocket 收到消息:', event.data)
                    if (typeof event.data === 'string') {
                        const data = JSON.parse(event.data);
                        switch (data.type) {
                            case 'started':
                                isServerReady = true;
                                console.log('语音服务器准备就绪');
                                break;
                            case 'underway':
                                console.log('用户开始说话...');
                                if (currentInputMode === 'videoCall' && mediaStream) {
                                    videoChunks = [];
                                    videoRecorder = new MediaRecorder(mediaStream, {mimeType: 'video/webm; codecs=vp9'});
                                    videoRecorder.ondataavailable = e => e.data.size > 0 && videoChunks.push(e.data);
                                    videoRecorder.onstop = () => {
                                        const videoBlob = new Blob(videoChunks, {type: 'video/webm'});
                                        sendHumanRequest(data.text, videoBlob); // 在 onstop 中发送，确保 blob 完整
                                    };
                                    videoRecorder.start();
                                    console.log('视频录制开始...');
                                }
                                break;
                            case 'complete':
                                console.log('收到识别结果:', data.text);
                                // 如果 data.text 是 ""、null 或 undefined，!data.text 都会是 true
                                if (!data || !data.text || isDigitalHumanSpeaking) {
                                    // 如果是视频模式且正在录制，可能是空消息标志着结束，需要停止录制
                                    if (currentInputMode === 'videoCall' && videoRecorder?.state === 'recording') {
                                        videoRecorder.stop(); // 停止录制，但因为没有文本，onstop 什么也不发
                                    }
                                    return;
                                }

                                // 修复第二步：将本次消息的文本保存在一个局部常量中
                                const recognizedText = data.text;

                                if (currentInputMode === 'videoCall' && videoRecorder?.state === 'recording') {
                                    // 重新定义 onstop，确保它在 videoRecorder.stop() 之前
                                    videoRecorder.onstop = () => {
                                        const videoBlob = new Blob(videoChunks, {type: videoRecorder.mimeType});
                                        // 修复第三步：在 onstop 回调中使用局部常量 recognizedText，而不是 data.text
                                        sendHumanRequest(recognizedText, videoBlob);
                                    };
                                    videoRecorder.stop();
                                    console.log('视频录制停止，等待数据发送...');

                                } else {
                                    // 纯语音通话，直接发送文本
                                    sendHumanRequest(recognizedText);
                                }

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
        processor?.disconnect();
        mediaStream?.getTracks().forEach(track => track.stop());
        audioContext?.close().catch(console.error);
        ws?.close();

        processor = mediaStream = audioContext = ws = videoRecorder = null;
        videoChunks = [];
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