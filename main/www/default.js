(async () => {
  const output = document.getElementById('status');
  try {
    const response = await fetch('/api/device', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const device = await response.json();
    output.textContent = JSON.stringify(device, null, 2);
  } catch (error) {
    output.textContent = `Could not load device status: ${error.message}`;
  }
})();
