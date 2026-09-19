import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

// Never read or modify a developer's personal naming-model preference in tests.
export function isolateConfig() {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'pi-tab-title-test-'));
  process.env.PI_CODING_AGENT_DIR = dir;
  after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
