function loadDesktopInputService() {
  if (process.platform === 'win32') {
    return require('./windows-input-service.cjs').DesktopInputService;
  }

  return require('./desktop-input-service.cjs').DesktopInputService;
}

function createDesktopInputService() {
  const DesktopInputService = loadDesktopInputService();
  return new DesktopInputService();
}

module.exports = {
  createDesktopInputService
};
