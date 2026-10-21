/* 探针：Git Data API 能否创建普通路径的 tree（用来判断 404 是「workflow 权限限制」还是别的） */
import { writeFileSync } from 'fs';
import { execFileSync } from 'child_process';

const REPO = 'iamfromchangsha/go9-go';
const TMP = 'D:\\minimax\\coder\\go9\\.gh-probe.json';

function gh(args, body) {
  const argv = [...args];
  if (body) {
    writeFileSync(TMP, JSON.stringify(body), 'utf8');
    argv.push('--input', TMP);
  }
  return execFileSync('gh', ['api', ...argv], { encoding: 'utf8' });
}
function tryTree(path, blobSha) {
  try {
    const t = JSON.parse(gh(['-X', 'POST', `repos/${REPO}/git/trees`], {
      base_tree: '24fc3dc28bfc0bd39c8e05e48d8a2c0c9ce52644',
      tree: [{ path, mode: '100644', type: 'blob', sha: blobSha }]
    }));
    console.log(`  ✓ ${path} → tree ${t.sha}`);
    return t.sha;
  } catch (e) {
    const msg = (e.stdout || e.message || '').toString().replace(/\s+/g, ' ').slice(0, 100);
    console.log(`  ✗ ${path} → ${msg}`);
    return null;
  }
}

const blob = JSON.parse(gh(['-X', 'POST', `repos/${REPO}/git/blobs`],
  { content: Buffer.from('probe').toString('base64'), encoding: 'base64' }));

console.log('普通路径：');
tryTree('tmp-probe.txt', blob.sha);
console.log('workflow 路径：');
tryTree('.github/workflows/build.yml', blob.sha);
