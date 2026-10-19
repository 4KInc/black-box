// The hosted Black Box: the replay, the case bench, the study and the lab, served live from the
// committed fixtures only (no local records, no keys, no PayPal calls). On Cloud Run (Dockerfile) or any host:
//   HOST=0.0.0.0 PORT=10000 node lab/hosted.mjs
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReplay } from '../replay/server.mjs';
import { siteIntro } from '../replay/page.mjs';

const ROOT = join(import.meta.dirname, '..');
const PORT = Number(process.env.PORT ?? 10000);
const HOST = process.env.HOST ?? '0.0.0.0';

// A scratch root holding only what is committed, plus the buyer's enrolled passkey (public key)
// in the registry the replay reads, exactly as the static site build does.
const root = mkdtempSync(join(tmpdir(), 'blackbox-hosted-'));
cpSync(join(ROOT, 'fixtures'), join(root, 'fixtures'), { recursive: true });
const enrolment = JSON.parse(readFileSync(join(root, 'fixtures', 'recorded', 'passkey-enrolment.json'), 'utf8'));
mkdirSync(join(root, 'records', 'passkeys'), { recursive: true });
writeFileSync(join(root, 'records', 'passkeys', `${enrolment.payer_id}.json`), JSON.stringify(enrolment));

createReplay({ root, intro: siteIntro({ live: true }) }).listen(PORT, HOST, () => console.log(`black box  http://${HOST}:${PORT}  (fixtures only)`));
