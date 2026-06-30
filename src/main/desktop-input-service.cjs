const { BrowserWindow, clipboard, nativeImage } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runAppleScript(script, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('/usr/bin/osascript', ['-'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('AppleScript 执行超时'));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `AppleScript 退出码 ${code}`));
      }
    });

    proc.stdin.end(script);
  });
}

function runCommand(command, args = [], timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`${path.basename(command)} 执行超时`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `${path.basename(command)} 退出码 ${code}`));
      }
    });
  });
}

function safeFileSegment(value, fallback = 'thread') {
  const segment = String(value || '')
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return segment || fallback;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatScreenshotTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return [
    date.getFullYear(),
    '-',
    pad2(date.getMonth() + 1),
    '-',
    pad2(date.getDate()),
    ' ',
    pad2(date.getHours()),
    ':',
    pad2(date.getMinutes()),
    ':',
    pad2(date.getSeconds())
  ].join('');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseBounds(value) {
  const parts = String(value || '').split(',').map((item) => Number.parseInt(item.trim(), 10));
  if (parts.length !== 4 || parts.some((item) => Number.isNaN(item))) {
    throw new Error(`无法识别 Codex 窗口位置：${value || 'empty'}`);
  }

  const [x, y, width, height] = parts;
  if (width < 160 || height < 120) {
    throw new Error(`Codex 窗口尺寸异常：${width}x${height}`);
  }

  return { x, y, width, height };
}

function accessibilityHelp(errorMessage = '') {
  return [
    '无法把消息粘贴到 Codex 界面。',
    '请在 macOS 系统设置 > 隐私与安全性 > 辅助功能 中允许 传令书。',
    '如果权限已开启，请先在 Codex 线程底部输入框点一下，再重试。',
    errorMessage ? `原始错误：${errorMessage}` : ''
  ].filter(Boolean).join('\n');
}

async function notifyStep(onStep, step, message) {
  if (typeof onStep !== 'function') return;
  try {
    await onStep({
      step,
      message,
      at: new Date().toISOString()
    });
  } catch {
    // Progress reporting must not block the actual paste flow.
  }
}

class DesktopInputService {
  async checkAccessibility() {
    const result = await runAppleScript(`
tell application "System Events"
  return UI elements enabled
end tell
`);
    return result === 'true';
  }

  async pasteIntoCodex({ text, threadId, openCodexThread, restoreClipboard = true, onStep }) {
    const prompt = String(text || '').trim();
    if (!prompt) {
      throw new Error('输入内容为空');
    }
    if (!threadId) {
      throw new Error('Codex 界面输入模式需要先绑定 threadId');
    }
    if (typeof openCodexThread !== 'function') {
      throw new Error('缺少打开 Codex 线程的能力');
    }

    await notifyStep(onStep, 'accessibility-check', '正在检查 macOS 辅助功能权限。');
    const accessibilityEnabled = await this.checkAccessibility().catch(() => false);
    if (!accessibilityEnabled) {
      throw new Error(accessibilityHelp('系统辅助功能未启用'));
    }
    await notifyStep(onStep, 'accessibility-ok', '辅助功能权限正常。');

    const previousClipboard = clipboard.readText();
    try {
      await notifyStep(onStep, 'open-thread', '正在打开 Codex 线程。');
      await openCodexThread(threadId);
      await notifyStep(onStep, 'thread-opened', '已打开 Codex 线程。');
    } catch (error) {
      throw new Error(`无法打开 Codex 线程：${error.message}`);
    }

    await delay(1300);
    clipboard.writeText(prompt);
    await notifyStep(onStep, 'clipboard-ready', '已准备剪贴板内容。');

    try {
      await this.tryPasteWithRetry(onStep);
      await notifyStep(onStep, 'pasted', '已粘贴并提交到 Codex 界面。');
    } catch (error) {
      throw new Error(accessibilityHelp(error.message));
    } finally {
      if (restoreClipboard) {
        setTimeout(() => clipboard.writeText(previousClipboard), 900);
      }
    }
  }

  async pasteRichIntoCodex({ text, imagePaths = [], threadId, openCodexThread, restoreClipboard = true, onStep }) {
    const prompt = String(text || '').trim();
    const images = Array.from(imagePaths || []).map((item) => String(item || '').trim()).filter(Boolean);
    if (!prompt && !images.length) {
      throw new Error('输入内容为空');
    }
    if (!threadId) {
      throw new Error('Codex 界面输入模式需要先绑定 threadId');
    }
    if (typeof openCodexThread !== 'function') {
      throw new Error('缺少打开 Codex 线程的能力');
    }

    await notifyStep(onStep, 'accessibility-check', '正在检查 macOS 辅助功能权限。');
    const accessibilityEnabled = await this.checkAccessibility().catch(() => false);
    if (!accessibilityEnabled) {
      throw new Error(accessibilityHelp('系统辅助功能未启用'));
    }
    await notifyStep(onStep, 'accessibility-ok', '辅助功能权限正常。');

    const previousClipboard = clipboard.readText();
    try {
      await notifyStep(onStep, 'open-thread', '正在打开 Codex 线程。');
      await openCodexThread(threadId);
      await notifyStep(onStep, 'thread-opened', '已打开 Codex 线程。');
    } catch (error) {
      throw new Error(`无法打开 Codex 线程：${error.message}`);
    }

    await delay(1300);
    try {
      for (const [index, imagePath] of images.entries()) {
        const image = nativeImage.createFromPath(imagePath);
        if (image.isEmpty()) {
          throw new Error(`无法读取图片：${imagePath}`);
        }
        clipboard.writeImage(image);
        await notifyStep(onStep, 'image-clipboard-ready', `已准备第 ${index + 1}/${images.length} 张图片。`);
        await this.tryPasteWithRetry(onStep, {
          submit: false,
          message: `正在粘贴第 ${index + 1}/${images.length} 张图片到 Codex。`
        });
        await delay(900);
      }

      if (prompt) {
        clipboard.writeText(prompt);
        await notifyStep(onStep, 'clipboard-ready', '已准备文字说明。');
        await this.tryPasteWithRetry(onStep, {
          submit: false,
          message: '正在粘贴文字说明。'
        });
        await delay(250);
      }

      await this.submitCodexInput(onStep);
      await notifyStep(onStep, 'pasted', images.length
        ? '已把图片和文字说明提交到 Codex 界面。'
        : '已粘贴并提交到 Codex 界面。');
    } catch (error) {
      throw new Error(accessibilityHelp(error.message));
    } finally {
      if (restoreClipboard) {
        setTimeout(() => clipboard.writeText(previousClipboard), 900);
      }
    }
  }

  async captureCodexThread({ threadId, openCodexThread, outputDir }) {
    if (!threadId) {
      throw new Error('缺少 Codex threadId，无法截图');
    }
    if (typeof openCodexThread !== 'function') {
      throw new Error('缺少打开 Codex 线程的能力，无法截图');
    }
    if (!outputDir) {
      throw new Error('缺少截图保存目录');
    }

    await openCodexThread(threadId);
    let bounds = null;
    let lastBoundsError = null;
    let lastBoundsText = '';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await delay(attempt === 0 ? 1400 : 700);

      const boundsText = await runAppleScript(`
tell application "Codex"
  activate
end tell
delay 0.4
tell application "System Events"
  if UI elements enabled is false then error "系统辅助功能未启用"
  tell process "Codex"
    set frontmost to true
    if (count of windows) is 0 then error "没有找到 Codex 窗口"
    set bestArea to 0
    set bestBounds to ""
    set fallbackArea to 0
    set fallbackBounds to ""
    repeat with i from 1 to count of windows
      set currentWindow to window i
      set minimizedWindow to false
      try
        set minimizedWindow to value of attribute "AXMinimized" of currentWindow
      end try
      if minimizedWindow is false then
        set winPosition to position of currentWindow
        set winSize to size of currentWindow
        set winWidth to item 1 of winSize
        set winHeight to item 2 of winSize
        set winArea to winWidth * winHeight
        set boundsText to (item 1 of winPosition as text) & "," & (item 2 of winPosition as text) & "," & (winWidth as text) & "," & (winHeight as text)
        if winArea > fallbackArea then
          set fallbackArea to winArea
          set fallbackBounds to boundsText
        end if
        if winWidth is greater than or equal to 160 and winHeight is greater than or equal to 120 and winArea > bestArea then
          set bestArea to winArea
          set bestBounds to boundsText
        end if
      end if
    end repeat
    if bestBounds is not "" then return bestBounds
    if fallbackBounds is not "" then return fallbackBounds
    error "没有找到可截图的 Codex 窗口"
  end tell
end tell
`, 12000);

      lastBoundsText = boundsText;
      try {
        bounds = parseBounds(boundsText);
        break;
      } catch (error) {
        lastBoundsError = error;
      }
    }

    if (!bounds) {
      throw lastBoundsError || new Error(`无法识别 Codex 窗口位置：${lastBoundsText || 'empty'}`);
    }

    fs.mkdirSync(outputDir, { recursive: true });

    const filePath = path.join(outputDir, `codex-${safeFileSegment(threadId)}-${Date.now()}.jpg`);
    try {
      await runCommand('/usr/sbin/screencapture', [
        '-x',
        '-t',
        'jpg',
        '-R',
        `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`,
        filePath
      ], 15000);
    } catch (error) {
      throw new Error([
        'Codex 窗口截图失败。',
        '请在 macOS 系统设置 > 隐私与安全性 > 屏幕录制 中允许 传令书。',
        `原始错误：${error.message}`
      ].join('\n'));
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error('截图文件为空，请检查屏幕录制权限');
    }

    const timestamp = formatScreenshotTimestamp(new Date());
    await this.addTimestampToScreenshot(filePath, timestamp);
    const annotatedStat = fs.statSync(filePath);

    return {
      filePath,
      size: annotatedStat.size,
      timestamp,
      bounds
    };
  }

  async addTimestampToScreenshot(filePath, timestamp) {
    if (!timestamp) return;

    const image = nativeImage.createFromPath(filePath);
    const size = image.getSize();
    if (!size.width || !size.height) {
      throw new Error('截图加时间戳失败：无法读取截图尺寸');
    }

    const fontSize = Math.max(13, Math.min(18, Math.round(size.width / 80)));
    const paddingX = Math.max(12, Math.round(fontSize * 0.9));
    const paddingY = Math.max(7, Math.round(fontSize * 0.48));
    const offset = Math.max(12, Math.round(fontSize * 0.9));
    const imageDataUrl = `data:image/jpeg;base64,${fs.readFileSync(filePath).toString('base64')}`;
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body {
      width: ${size.width}px;
      height: ${size.height}px;
      margin: 0;
      overflow: hidden;
      background: #111827;
    }
    img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .timestamp {
      position: fixed;
      top: ${offset}px;
      right: ${offset}px;
      padding: ${paddingY}px ${paddingX}px;
      border-radius: 8px;
      background: rgba(17, 24, 39, 0.78);
      color: #fff;
      font: 600 ${fontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
      line-height: 1;
      letter-spacing: 0;
      box-shadow: 0 8px 22px rgba(0, 0, 0, 0.22);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <img src="${imageDataUrl}" alt="">
  <div class="timestamp">截图 ${escapeHtml(timestamp)}</div>
</body>
</html>`;

    const window = new BrowserWindow({
      width: size.width,
      height: size.height,
      show: false,
      frame: false,
      transparent: false,
      resizable: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });

    try {
      await window.loadURL('about:blank');
      await window.webContents.executeJavaScript(`
        (() => new Promise((resolve, reject) => {
          document.open();
          document.write(${JSON.stringify(html.replace(imageDataUrl, ''))});
          document.close();
          const image = document.querySelector('img');
          if (!image) {
            reject(new Error('missing screenshot image element'));
            return;
          }
          image.onload = () => requestAnimationFrame(() => resolve(true));
          image.onerror = () => reject(new Error('screenshot image load failed'));
          image.src = ${JSON.stringify(imageDataUrl)};
        }))()
      `);
      await delay(80);
      const annotated = await window.webContents.capturePage();
      fs.writeFileSync(filePath, annotated.toJPEG(88));
    } finally {
      if (!window.isDestroyed()) window.destroy();
    }
  }

  async submitCodexInput(onStep) {
    await notifyStep(onStep, 'submit', '正在提交到 Codex。');
    await runAppleScript(`
tell application "Codex"
  activate
end tell
delay 0.25
tell application "System Events"
  if UI elements enabled is false then error "系统辅助功能未启用"
  tell process "Codex"
    set frontmost to true
  end tell
  delay 0.15
  key code 36
end tell
`, 12000);
  }

  async tryPasteWithRetry(onStep, options = {}) {
    const submit = options.submit !== false;
    const message = options.message || (submit ? '正在粘贴并回车。' : '正在粘贴。');
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await delay(900);
      try {
        await notifyStep(onStep, 'paste-attempt', attempt > 0 ? '正在重试粘贴。' : message);
        await runAppleScript(`
tell application "Codex"
  activate
end tell
delay 0.55
tell application "System Events"
  if UI elements enabled is false then error "系统辅助功能未启用"
  tell process "Codex"
    set frontmost to true
  end tell
  delay 0.35
  keystroke "v" using {command down}
  ${submit ? 'delay 0.25\n  key code 36' : ''}
end tell
`, 12000);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('粘贴失败');
  }
}

module.exports = {
  DesktopInputService,
  runAppleScript
};
