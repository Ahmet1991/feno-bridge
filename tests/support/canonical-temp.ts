import {mkdtempSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

/** Native APIs return canonical paths, including when TEMP uses an 8.3 alias. */
export function canonicalTemp(prefix:string):string {
  return realpathSync.native(mkdtempSync(join(tmpdir(),prefix)));
}
