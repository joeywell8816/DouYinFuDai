'use strict'; // 启用严格模式，提高代码安全性

  var root =
    (typeof globalThis !== 'undefined' && globalThis) ||
    (typeof global !== 'undefined' && global) ||
    (typeof window !== 'undefined' && window) ||
    (typeof this !== 'undefined' && this) ||
    {};

  // WebSocket 客户端状态管理对象
  var WSClient = {
    ws: null,                   // WebSocket 连接实例
    wsUrl: '',                  // WebSocket 服务器地址
    reconnectTimer: null,       // 重连定时器
    reconnectDelayMs: 10000,    // 重连延迟时间（10秒）

    // 设备注册信息
    deviceId: '',              // 设备唯一标识
    deviceInfo: '',            // 设备信息描述
    projectName: '',           // 项目名称
    phoneNum: '',              // 手机号码

    // 心跳机制
    heartbeatTimer: null,       // 心跳定时器
    heartbeatIntervalMs: 30000, // 心跳间隔时间（30秒）

    // 图片发送控制
    lastImageSendAt: 0,        // 上次图片发送时间戳
    imageSendTimer: null,      // 图片发送定时器（用于节流）
    pendingImageSource: null,  // 待发送的图片源（节流时暂存）

    // 配置参数
    maxImageBytes: 200 * 1024, // 图片最大字节数（200KB）
    throttleMs: 800            // 图片发送节流时间（800ms）
  };

  var _setTimeout = (typeof setTimeout === 'function' && setTimeout) || (root && root.setTimeout);
  var _clearTimeout = (typeof clearTimeout === 'function' && clearTimeout) || (root && root.clearTimeout);
  var _setInterval = (typeof setInterval === 'function' && setInterval) || (root && root.setInterval);
  var _clearInterval = (typeof clearInterval === 'function' && clearInterval) || (root && root.clearInterval);

  if (typeof _setTimeout !== 'function') _setTimeout = function () { return null; };
  if (typeof _clearTimeout !== 'function') _clearTimeout = function () {};
  if (typeof _setInterval !== 'function') _setInterval = function () { return null; };
  if (typeof _clearInterval !== 'function') _clearInterval = function () {};

  // 获取当前时间戳（毫秒）
  function nowMs() {
    return new Date().getTime();
  }

  // 安全清除定时器（避免异常）
  function clearTimer(t) {
    if (t) {
      try {
        _clearTimeout(t);
      } catch (e) {}
    }
  }

  // 安全清除间隔定时器
  function clearIntervalSafe(t) {
    if (t) {
      try {
        _clearInterval(t);
      } catch (e) {}
    }
  }

  // 安全的 JSON 解析，解析失败返回 null
  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  // 判断是否为字符串类型
  function isString(v) {
    return typeof v === 'string' || v instanceof String;
  }

  // 构建 WebSocket URL
  function buildWsUrl(ip, port) {
    var host = (ip || '').replace(/^\s+|\s+$/g, ''); // 去除前后空格
    var p = (port || '').replace(/^\s+|\s+$/g, '');
    if (!host) {
      host = '127.0.0.1'; // 默认本地地址
    }
    if (!p) {
      p = '0'; // 默认端口
    }
    return 'ws://' + host + ':' + p + '/';
  }

  // 安排重连任务
  function scheduleReconnect() {
    clearTimer(WSClient.reconnectTimer);
    WSClient.reconnectTimer = _setTimeout(function () {
      connectInternal(); // 延迟后重新连接
    }, WSClient.reconnectDelayMs);
  }

  // 启动心跳机制
  function startHeartbeat() {
    clearIntervalSafe(WSClient.heartbeatTimer);
    WSClient.heartbeatTimer = _setInterval(function () {
      if (!WSClient.ws || WSClient.ws.readyState !== 1) {
        return; // 连接未就绪时不发送心跳
      }
      try {
        // 发送心跳包，包含时间戳
        WSClient.ws.send(JSON.stringify({ type: 'heartbeat', ts: new Date().getTime() }));
      } catch (e) {}
    }, WSClient.heartbeatIntervalMs);
  }

  // 停止心跳机制
  function stopHeartbeat() {
    clearIntervalSafe(WSClient.heartbeatTimer);
    WSClient.heartbeatTimer = null;
  }

  // 发送设备注册信息到服务器
  function sendRegister() {
    if (!WSClient.ws || WSClient.ws.readyState !== 1) {
      return; // 连接未就绪时不发送
    }
    // 构建注册信息负载，包含所有设备相关信息
    var payload = {
      type: 'register',        // 消息类型：注册
      device_id: WSClient.deviceId,  // 设备ID
      ac: WSClient.deviceId,        // 设备标识（与device_id相同）
      device: WSClient.deviceInfo,   // 设备信息描述
      obj: WSClient.projectName,     // 项目名称
      phoneNum: WSClient.phoneNum    // 手机号码
    };
    try {
      // 发送JSON格式的注册信息
      WSClient.ws.send(JSON.stringify(payload));
    } catch (e) {}
  }

  // 内部连接函数，建立 WebSocket 连接并设置事件处理器
  function connectInternal() {
    if (!WSClient.wsUrl) {
      return; // 没有有效的URL时不连接
    }

    // 清理旧的连接（如果存在）
    try {
      if (WSClient.ws) {
        try {
          // 移除所有事件监听器，避免内存泄漏
          WSClient.ws.onopen = null;
          WSClient.ws.onclose = null;
          WSClient.ws.onerror = null;
          WSClient.ws.onmessage = null;
          WSClient.ws.close(); // 关闭旧连接
        } catch (e1) {}
      }
    } catch (e2) {}

    stopHeartbeat(); // 停止心跳

    try {
      // 创建新的 WebSocket 连接
      WSClient.ws = new WebSocket(WSClient.wsUrl);
    } catch (e3) {
      scheduleReconnect(); // 连接失败时安排重连
      return;
    }

    // 设置二进制数据类型为 ArrayBuffer（用于图片传输）
    WSClient.ws.binaryType = 'arraybuffer';

    // 连接建立成功事件
    WSClient.ws.onopen = function () {
      sendRegister();           // 发送注册信息
      startHeartbeat();         // 启动心跳
      flushPendingImageIfAny(); // 发送之前暂存的图片（如果有）
    };

    // 连接关闭事件
    WSClient.ws.onclose = function () {
      stopHeartbeat();      // 停止心跳
      scheduleReconnect();  // 安排重连
    };

    // 连接错误事件
    WSClient.ws.onerror = function () {
      try {
        if (WSClient.ws) {
          WSClient.ws.close(); // 发生错误时关闭连接
        }
      } catch (e) {}
    };

    // 收到服务器消息事件
    WSClient.ws.onmessage = function (evt) {
      onServerMessage(evt); // 处理服务器消息
    };
  }

  // 处理服务器发送的消息
  function onServerMessage(evt) {
    var dataText = null;

    // 只处理字符串类型的消息（JSON格式）
    if (evt && typeof evt.data === 'string') {
      dataText = evt.data;
    }

    if (!dataText) {
      return; // 非文本消息或空消息忽略
    }

    // 安全解析JSON
    var json = safeJsonParse(dataText);
    if (!json) {
      return; // JSON解析失败忽略
    }

    // 调用JSON消息处理函数
    handleServerJson(json);
  }

  // 处理服务器下发的JSON命令
  function handleServerJson(json) {
    if (!json) {
      return;
    }

    // 提取动作类型，优先使用action字段，其次使用type字段
    var action = json.action;
    if (!action) {
      action = json.type;
    }

    // 如果外部设置了自定义处理函数，优先调用外部函数
    try {
      if (typeof WSClient.onServerJson === 'function') {
        WSClient.onServerJson(json);
        return;
      }
    } catch (e1) {}

    // 内置命令处理逻辑
    if (action === '截取图片') {
      // 截取图片命令 - 外部程序需要响应此命令并调用sendImage
      return;
    }

    if (action === '开始控制') {
      // 开始控制命令 - 外部程序需要开始发送图片
      return;
    }

    if (action === '停止控制') {
      // 停止控制命令 - 外部程序需要停止发送图片
      return;
    }

    // 其他未处理的消息输出到控制台（开发调试用）
    try {
      if (root.console && typeof root.console.log === 'function') {
        root.console.log('收到服务器消息:', json);
      }
    } catch (e2) {}
  }

  function base64ToUint8Array(base64) {
    if (typeof atob === 'function') {
      var binary = atob(base64);
      var len = binary.length;
      var bytes = new Uint8Array(len);
      var i = 0;
      for (i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i) & 0xff;
      }
      return bytes;
    }

    try {
      if (typeof java !== 'undefined' && java.util && java.util.Base64) {
        var decoded = java.util.Base64.getDecoder().decode(base64);
        var out = new Uint8Array(decoded.length);
        var j = 0;
        for (j = 0; j < decoded.length; j++) {
          out[j] = decoded[j] & 0xff;
        }
        return out;
      }
    } catch (e1) {}

    try {
      if (typeof android !== 'undefined' && android.util && android.util.Base64) {
        var decoded2 = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
        var out2 = new Uint8Array(decoded2.length);
        var k = 0;
        for (k = 0; k < decoded2.length; k++) {
          out2[k] = decoded2[k] & 0xff;
        }
        return out2;
      }
    } catch (e2) {}

    return null;
  }

  // 将DataURL转换为字节数组
  function dataUrlToBytes(dataUrl) {
    var idx = dataUrl.indexOf(',');
    if (idx < 0) {
      return null; // 无效的DataURL格式
    }
    var meta = dataUrl.substring(0, idx);   // 元数据部分
    var b64 = dataUrl.substring(idx + 1);    // Base64数据部分

    if (meta.indexOf(';base64') < 0) {
      return null; // 不是Base64编码的DataURL
    }
    return base64ToUint8Array(b64); // 转换Base64为字节数组
  }

  // 创建指定宽高的Canvas元素
  function createCanvas(w, h) {
    if (typeof document === 'undefined' || !document || !document.createElement) {
      return null;
    }
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }

  // 获取图像源的尺寸信息
  function getSourceSize(source) {
    if (!source) {
      return null;
    }
    var w = 0;
    var h = 0;

    // 支持多种图像源类型：Image、Bitmap、Video等
    if (typeof source.width === 'number' && typeof source.height === 'number') {
      w = source.width;
      h = source.height;
    } else if (typeof source.videoWidth === 'number' && typeof source.videoHeight === 'number') {
      w = source.videoWidth;
      h = source.videoHeight;
    }

    if (!w || !h) {
      return null; // 无法获取有效尺寸
    }
    return { width: w, height: h };
  }

  // 将图像源绘制到Canvas上
  function drawToCanvas(source, canvas) {
    if (!canvas || !canvas.getContext) {
      return;
    }
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height); // 清空画布
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height); // 绘制图像
  }

  // 将图像源编码为JPEG字节数组
  function encodeJpegBytes(source, scale, quality) {
    var size = getSourceSize(source);
    if (!size) {
      return null; // 无法获取图像尺寸
    }

    // 根据缩放比例计算目标尺寸
    var w = Math.max(1, Math.floor(size.width * scale));
    var h = Math.max(1, Math.floor(size.height * scale));
    var canvas = createCanvas(w, h);
    if (!canvas) {
      return null;
    }
    drawToCanvas(source, canvas); // 将图像绘制到Canvas

    // 确保质量参数在有效范围内（0-1）
    var q = quality;
    if (q > 1) q = 1;
    if (q < 0) q = 0;

    var dataUrl = null;
    try {
      // 尝试使用指定质量参数编码为JPEG
      dataUrl = canvas.toDataURL('image/jpeg', q);
    } catch (e) {
      try {
        // 质量参数失败时使用默认质量
        dataUrl = canvas.toDataURL('image/jpeg');
      } catch (e2) {
        return null; // 编码失败
      }
    }

    // 将DataURL转换为字节数组返回
    return dataUrlToBytes(dataUrl);
  }

  // 压缩图像到指定最大字节数
  function compressToMaxBytes(source, maxBytes) {
    var best = null;      // 最佳压缩结果（最小的有效压缩）
    var attempt = null;   // 当前尝试的压缩结果

    // 缩放比例候选值（从原尺寸到50%）
    var scaleCandidates = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5];
    // 质量参数候选值（从高质量到低质量）
    var qualityCandidates = [0.92, 0.85, 0.78, 0.72, 0.66, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3];

    var si = 0;
    var qi = 0;
    // 双重循环尝试所有缩放比例和质量组合
    for (si = 0; si < scaleCandidates.length; si++) {
      for (qi = 0; qi < qualityCandidates.length; qi++) {
        // 尝试编码
        attempt = encodeJpegBytes(source, scaleCandidates[si], qualityCandidates[qi]);
        if (attempt && attempt.length > 0) {
          // 更新最佳压缩结果（选择最小的有效压缩）
          if (!best || attempt.length < best.length) {
            best = attempt;
          }
          // 如果当前压缩结果满足大小要求，立即返回
          if (attempt.length <= maxBytes) {
            return attempt;
          }
        }
      }
    }

    // 返回最佳压缩结果（即使可能超过最大字节数）
    return best;
  }

  // 发送二进制数据到服务器
  function sendBinary(bytes) {
    if (!bytes || !bytes.length) {
      return; // 空数据不发送
    }
    if (!WSClient.ws || WSClient.ws.readyState !== 1) {
      return; // 连接未就绪不发送
    }

    try {
      WSClient.ws.send(bytes); // 发送二进制数据
    } catch (e) {}
  }

  // 安排图片发送任务（实现节流功能）
  function scheduleImageSend(source) {
    WSClient.pendingImageSource = source; // 暂存待发送的图片源

    // 计算需要等待的时间（实现800ms节流）
    var elapsed = nowMs() - WSClient.lastImageSendAt;
    var waitMs = WSClient.throttleMs - elapsed;
    if (waitMs < 0) {
      waitMs = 0; // 如果已经超过节流时间，立即发送
    }

    // 清除之前的定时器，确保只发送最新的图片
    clearTimer(WSClient.imageSendTimer);
    WSClient.imageSendTimer = _setTimeout(function () {
      flushPendingImageIfAny(); // 延迟后发送图片
    }, waitMs);
  }

  // 发送暂存的图片（如果存在）
  function flushPendingImageIfAny() {
    if (!WSClient.pendingImageSource) {
      return; // 没有待发送的图片
    }
    if (!WSClient.ws || WSClient.ws.readyState !== 1) {
      return; // 连接未就绪
    }

    var source = WSClient.pendingImageSource;
    WSClient.pendingImageSource = null; // 清空暂存

    // 先尝试高质量编码（92%质量，不缩放）
    var bytes = encodeJpegBytes(source, 1.0, 0.92);
    // 如果超过200KB，进行压缩
    if (bytes && bytes.length > WSClient.maxImageBytes) {
      bytes = compressToMaxBytes(source, WSClient.maxImageBytes);
    }
    if (!bytes || !bytes.length) {
      return; // 编码或压缩失败
    }

    // 最终检查大小（确保不超过200KB）
    if (bytes.length > WSClient.maxImageBytes) {
      return; // 仍然超过限制，放弃发送
    }

    sendBinary(bytes); // 发送二进制图片数据
    WSClient.lastImageSendAt = nowMs(); // 更新最后发送时间
  }

  // 启动WebSocket客户端连接
  // 参数：服务器IP、端口、设备ID、设备信息、项目名称、手机号码
  function starClient(serverIp, port, deviceId, deviceInfo, projectName, phoneNum) {
    // 确保所有参数都是字符串类型
    if (!isString(serverIp)) serverIp = '' + serverIp;
    if (!isString(port)) port = '' + port;
    if (!isString(deviceId)) deviceId = '' + deviceId;
    if (!isString(deviceInfo)) deviceInfo = '' + deviceInfo;
    if (!isString(projectName)) projectName = '' + projectName;
    if (!isString(phoneNum)) phoneNum = '' + phoneNum;

    // 配置客户端参数
    WSClient.wsUrl = buildWsUrl(serverIp, port); // 构建WebSocket URL
    WSClient.deviceId = deviceId;        // 设备唯一标识
    WSClient.deviceInfo = deviceInfo;    // 设备信息描述
    WSClient.projectName = projectName;  // 项目名称
    WSClient.phoneNum = phoneNum;        // 手机号码

    // 清理之前的重连定时器
    clearTimer(WSClient.reconnectTimer);
    WSClient.reconnectTimer = null;
    connectInternal(); // 开始连接
  }

  // 发送图像到服务器
  // 参数：Image或Bitmap类型的图像对象
  function sendImage(imageOrBitmap) {
    if (!imageOrBitmap) {
      return; // 空图像不处理
    }

    if (typeof ArrayBuffer !== 'undefined' && imageOrBitmap instanceof ArrayBuffer) {
      sendBinary(imageOrBitmap);
      return;
    }

    if (typeof Uint8Array !== 'undefined' && imageOrBitmap instanceof Uint8Array) {
      sendBinary(imageOrBitmap);
      return;
    }

    // 处理未加载完成的图像（如图片还在加载中）
    if (typeof imageOrBitmap.complete === 'boolean' && imageOrBitmap.complete === false) {
      try {
        // 设置加载完成后的回调，自动发送图片
        imageOrBitmap.onload = function () {
          scheduleImageSend(imageOrBitmap);
        };
      } catch (e) {}
      return; // 等待图片加载完成
    }

    // 安排图片发送（包含压缩和节流处理）
    scheduleImageSend(imageOrBitmap);
  }

  if (root) {
    try {
      root.WSClient = WSClient;
      root.starClient = starClient;
      root.sendImage = sendImage;
      root.handleServerJson = handleServerJson;
    } catch (e1) {}
  }

  try {
    if (typeof module !== 'undefined' && module && module.exports) {
      module.exports = {
        WSClient: WSClient,
        starClient: starClient,
        sendImage: sendImage,
        handleServerJson: handleServerJson
      };
    }
  } catch (e2) {}
