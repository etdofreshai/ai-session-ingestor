import { describe,it,expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonLines } from '../src/lib/common.js';

describe('streamed session input',()=>{
  it('preserves physical line identities across blanks, bad records, CRLF, and appended data',async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'session-stream-'));
    const file=path.join(dir,'session.jsonl');
    try {
      await fs.writeFile(file,'{"a":1}\r\n\r\ninvalid\n{"a":2}\n{"a":');
      const first=[]; for await(const row of readJsonLines(file)) first.push(row);
      expect(first.map(x=>x.lineNumber)).toEqual([1,4]);
      await fs.appendFile(file,'3}\n');
      const second=[]; for await(const row of readJsonLines(file)) second.push(row);
      expect(second.map(x=>x.lineNumber)).toEqual([1,4,5]);
      expect(second[2].value).toEqual({a:3});
    } finally {await fs.rm(dir,{recursive:true,force:true});}
  });
});
