// Real pgTAP on the named Knufl preview. Authenticated Supabase CLI, no DB
// password/keys in arguments. Every fixture and transport simulation rolls back.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
const args = ['--yes','supabase@latest','db','query','--linked','--project-ref','ntymjigywntaczxiqpdh'];
const query = tail => execFileSync('npx',[...args,...tail],{encoding:'utf8',stdio:['ignore','pipe','pipe']});

// The Management API may return only the final nonempty result. Prove that a
// failed assertion cannot be hidden by finish/rollback or a later passing row.
let detected = false;
try {
  query(["begin; create extension if not exists pgtap with schema extensions; select plan(1); select ok(false,'intentional harness calibration'); select * from finish(true); rollback;"]);
} catch(error) {
  detected = /test.*fail|failed.*test/i.test(String(error.stdout)+' '+String(error.stderr));
}
if(!detected) throw new Error('Live pgTAP failure detection could not be verified.');
console.log('LIVE pgTAP harness: deliberately failed assertion correctly rejected.');
let total=0;
for(const name of readdirSync('supabase/tests').filter(n=>n.endsWith('.sql')).sort()) {
  const path='supabase/tests/'+name;
  const sql=readFileSync(path,'utf8');
  if(!sql.includes('finish(true)') || !sql.trimEnd().endsWith('rollback;')) {
    throw new Error('Refusing a test without failure propagation and rollback: '+name);
  }
  const planned=Number(sql.match(/select plan\((\d+)\)/i)?.[1]);
  query(['--file',path]);
  total+=planned;
  console.log(`LIVE pgTAP: ${name}, ${planned} assertions passed; fixtures rolled back.`);
}
console.log(`PASS: ${total} live PostgreSQL/pgTAP assertions. OpenAI HTTP responses in supervisor tests are simulated, not live.`);
