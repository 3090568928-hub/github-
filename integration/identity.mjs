import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Chromium hashes this public key to give every local build the same extension ID.
const publicKey = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAogjDQ5aaw7qfzg3smD/SBD55VtnLL0/WzxDFY+g6VMEaMyn9zc+HC/MQ2nT+TeyPOOIuW6osh1oTSLsufRB2Oee8EWUaemBdbJb/dzGdrd27juPNkIEjiKHrmVFG8Yfd0fkrU30wC58ayPIsvmx0SR/3smVoqoIAxn96t26uxWnDub+ZwcLBZnK4hSxl/iwNCA4/7B3JhTwgLCUckLRMQhoJBKGREQh7cFo2Na39uSjP89U17/9YT02GDSDaKzk1P6SfpzdgWGri0YwnogAIyJwS1Y9jR8J0TuD59Hl/UcdepsVyzfYytfRFWkE1mJnAXQoOwlypstsQ8GAErmUb/QIDAQAB';
const mergedId = [...createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 32)]
  .map(digit => String.fromCharCode(97 + parseInt(digit, 16))).join('');
const storeIds = new Set([
  'amkbmndfnliijdhojkpoglbnaaahippg',
  'bpoadfkcbjbfhfodiogcnhhhpibjhbnh',
  'cfhamdkdjgoelclgllcoikbckcfpaklj',
]);

export async function applyIdentity({ manifest, outDir }) {
  for (const resource of manifest.declarative_net_request?.rule_resources ?? []) {
    const file = path.resolve(outDir, resource.path);
    const relative = path.relative(outDir, file);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('规则文件位于扩展目录外。');
    }
    const rules = JSON.parse(await readFile(file, 'utf8'));
    for (const rule of rules) {
      if (rule.condition?.initiatorDomains?.some(domain => storeIds.has(domain))) {
        // Send this extension's own identity to services that use extension origins.
        for (const header of rule.action?.requestHeaders ?? []) {
          if (header.header.toLowerCase() === 'origin' && header.operation === 'set' &&
              /^chrome-extension:\/\/[a-p]{32}\/?$/.test(header.value ?? '')) {
            header.value = 'chrome-extension://' + mergedId;
          }
        }
        rule.condition.initiatorDomains = [mergedId];
      }
    }
    await writeFile(file, JSON.stringify(rules, null, 2) + '\n');
  }
  manifest.key = publicKey;
}
