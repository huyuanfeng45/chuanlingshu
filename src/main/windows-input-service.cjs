const { clipboard } = require('electron');
const { spawn } = require('child_process');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runPowerShell(script, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('PowerShell 执行超时'));
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
        reject(new Error(stderr.trim() || stdout.trim() || `PowerShell 退出码 ${code}`));
      }
    });
  });
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

function windowsPasteHelp(errorMessage = '') {
  return [
    '无法把消息粘贴到 Codex 界面。',
    '请确认 Windows 已安装 Codex App，并且 codex://threads 链接可以打开目标线程。',
    '如果 Codex 已打开但没有粘贴进去，请先点一下 Codex 线程底部输入框，再从飞书重发消息。',
    errorMessage ? `原始错误：${errorMessage}` : ''
  ].filter(Boolean).join('\n');
}

class DesktopInputService {
  async checkAccessibility() {
    return true;
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

    await notifyStep(onStep, 'input-ready', 'Windows 界面输入无需 macOS 辅助功能权限。');

    const previousClipboard = clipboard.readText();
    try {
      await notifyStep(onStep, 'open-thread', '正在打开 Codex 线程。');
      await openCodexThread(threadId);
      await notifyStep(onStep, 'thread-opened', '已打开 Codex 线程。');
    } catch (error) {
      throw new Error(`无法打开 Codex 线程：${error.message}`);
    }

    await delay(1500);
    clipboard.writeText(prompt);
    await notifyStep(onStep, 'clipboard-ready', '已准备剪贴板内容。');

    try {
      await this.tryPasteWithRetry(onStep);
      await notifyStep(onStep, 'pasted', '已粘贴并提交到 Codex 界面。');
    } catch (error) {
      throw new Error(windowsPasteHelp(error.message));
    } finally {
      if (restoreClipboard) {
        setTimeout(() => clipboard.writeText(previousClipboard), 900);
      }
    }
  }

  async captureCodexThread() {
    throw new Error('Windows 版本暂未启用 Codex 窗口截图回传，请先使用文本状态和最终回复回传。');
  }

  async tryPasteWithRetry(onStep) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await delay(900);
      try {
        await notifyStep(onStep, 'paste-attempt', attempt > 0 ? '正在重试粘贴。' : '正在粘贴并回车。');
        await runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
try { Add-Type -AssemblyName Microsoft.VisualBasic | Out-Null } catch {}

$codexProcess = Get-Process | Where-Object {
  $_.MainWindowHandle -ne 0 -and (
    $_.ProcessName -match 'Codex' -or
    $_.MainWindowTitle -match 'Codex'
  )
} | Select-Object -First 1
$interactionType = 'Microsoft.VisualBasic.Interaction' -as [type]

if ($codexProcess -and $interactionType) {
  [Microsoft.VisualBasic.Interaction]::AppActivate($codexProcess.Id) | Out-Null
  Start-Sleep -Milliseconds 450
}

[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 250
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
`, 15000);
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
  runPowerShell
};
