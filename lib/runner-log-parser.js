'use strict';

const LABELS = {
  cpu: [/(?:CPU|Processor)(?:\s+(?:Model|Name|Type))?\s*[:=]\s*(.+)$/i],
  cores: [/(?:CPU\s*)?(?:Cores?|Threads?)(?:\s*\/\s*Threads?)?\s*[:=]\s*(.+)$/i],
  ram: [/(?:RAM|Memory|Total\s+Memory)(?:\s*\([^)]*\))?\s*[:=]\s*(.+)$/i],
  disk: [/(?:Disk(?:\s*\([^)]*\))?|Storage)(?:\s+(?:Size|Total))?\s*[:=]\s*(.+)$/i],
  os: [/(?:OS|Operating\s+System|Windows\s+Version)\s*[:=]\s*(.+)$/i],
  address: [/(?:RDP\s*)?(?:Address|IP(?:\s+Address)?|Host)(?:\s*\([^)]*\))?\s*[:=]\s*(.+)$/i],
  username: [/(?:RDP\s*)?(?:Username|User\s*name|Login)\s*[:=]\s*(.+)$/i],
  password: [/(?:RDP\s*)?(?:Password|Passcode)\s*[:=]\s*(.+)$/i]
};

function clean(value) {
  return String(value || '').replace(/\x1b\[[0-9;]*m/g, '').trim().replace(/^['"`]|['"`]$/g, '');
}

function parseRunnerLog(input) {
  const text = String(input || '').replace(/\r/g, '');
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const details = { cpu: '', cores: '', ram: '', disk: '', os: '', address: '', username: '', password: '', aliveLine: '' };
  // Prefer the last matching value because workflows may print a preliminary value before final setup.
  for (const [field, patterns] of Object.entries(LABELS)) {
    for (let i = lines.length - 1; i >= 0 && !details[field]; i -= 1) {
      const line = clean(lines[i]);
      if (/\*\*\*/.test(line)) continue;
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match && match[1]) {
          const value = clean(match[1]);
          if (value && value.length < 500 && !/^\*+$/.test(value)) details[field] = value;
          break;
        }
      }
    }
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = clean(lines[i]);
    if (/alive.{0,80}RDP\s*:/i.test(line) || /alive.*rdp/i.test(line)) {
      details.aliveLine = line.slice(0, 500);
      break;
    }
  }
  const lastLines = lines.slice(-35).map(line => {
    let safe = clean(line);
    if (/password|passcode|secret|token\s*[:=]/i.test(safe)) safe = safe.replace(/([:=]\s*).+$/,'$1[REDACTED]');
    if (details.password) safe = safe.split(details.password).join('[REDACTED]');
    return safe.slice(0, 1200);
  });
  return { details, recentLines: lastLines };
}

module.exports = { parseRunnerLog };
