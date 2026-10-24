import { describe, expect, it } from 'vitest';
import { hasMoovAtom } from '../lib/machine/box.mts';

function atom(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

function largeAtom(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(16);
  head.writeUInt32BE(1);
  head.write(type, 4, 'latin1');
  head.writeBigUInt64BE(BigInt(16 + payload.length), 8);
  return Buffer.concat([head, payload]);
}

describe('a finished mp4', () => {
  it('has a top-level moov atom, before or after its media data', () => {
    const media = atom('mdat', Buffer.from('frames'));
    expect(hasMoovAtom(Buffer.concat([atom('ftyp'), atom('moov'), media]))).toBe(true);
    expect(hasMoovAtom(Buffer.concat([atom('ftyp'), media, atom('moov')]))).toBe(true);
    expect(hasMoovAtom(Buffer.concat([atom('ftyp'), largeAtom('mdat', media), atom('moov')]))).toBe(
      true,
    );
  });

  it('is not a file whose media data merely contains the bytes "moov"', () => {
    const unfinished = Buffer.concat([atom('ftyp'), atom('mdat', Buffer.from('..moov..'))]);
    expect(unfinished.includes('moov')).toBe(true);
    expect(hasMoovAtom(unfinished)).toBe(false);
  });

  it('is not a truncated or empty file', () => {
    const cut = Buffer.concat([atom('ftyp'), atom('mdat', Buffer.alloc(64))]).subarray(0, 40);
    expect(hasMoovAtom(cut)).toBe(false);
    expect(hasMoovAtom(Buffer.alloc(0))).toBe(false);
    const short = atom('moov', Buffer.alloc(992)).subarray(0, 18);
    expect(hasMoovAtom(Buffer.concat([atom('ftyp'), short]))).toBe(false);
    const media = atom('mdat', Buffer.alloc(64)).subarray(0, 40);
    expect(hasMoovAtom(Buffer.concat([atom('ftyp'), atom('moov'), media]))).toBe(false);
  });
});
