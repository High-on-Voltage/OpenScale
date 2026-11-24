(async () => {
  const byId = (id) => document.getElementById(id);
  try {
    const [deviceResponse, statusResponse] = await Promise.all([
      fetch('/api/device', {cache: 'no-store'}),
      fetch('/api/status', {cache: 'no-store'}),
    ]);
    const device = deviceResponse.ok ? await deviceResponse.json() : {error: `device HTTP ${deviceResponse.status}`};
    const status = statusResponse.ok ? await statusResponse.json() : {error: `status HTTP ${statusResponse.status}`};
    byId('firmware').textContent = device.firmwareVersion ?? 'unknown';
    byId('webui').textContent = device.webuiVersion ?? 'unknown';
    byId('status').textContent = JSON.stringify({device, status}, null, 2);
  } catch (error) {
    byId('status').textContent = String(error);
  }
})();
