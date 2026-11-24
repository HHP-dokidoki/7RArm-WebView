import { describe, expect, it } from 'vitest';
import { frameTable, parseRecording, resample, splitTrack } from '../src/teach';

const header = 'mcu_us,host_t,v0,v1,v2,v3,v4,v5,v6,v7';
const row = (us: number, side: number, q: number) => `${us},1,${side},${q},-0.7,0,0.8,0,0,0`;

describe('HostLink recordings', () => {
  it('splits clock regressions and retains the latest duplicate per arm', () => {
    const result = parseRecording([
      header, row(125000, 0, 0), row(124000, 1, 9), row(145000, 0, 1),
      row(145000, 0, 2), row(35000, 0, 3), row(55000, 0, 4), '60000,1,0,3,0',
    ].join('\n'));
    expect(result.truncated).toBe(true);
    expect(splitTrack(result.samples, 0).map(track => track.map(sample => sample.q[0])))
      .toEqual([[0, 2], [3, 4]]);
  });

  it('retains the endpoints and the exact recording duration', () => {
    const result = parseRecording([header, row(1000, 0, 0), row(206000, 0, 1)].join('\n'));
    const frames = resample(result.samples, 120);
    expect(frames.map(frame => frame.q[0])).toEqual([0, 0.5, 1]);
    expect(frames.map(frame => frame.ms)).toEqual([103, 102, 0]);
  });

  it('exports scoped aliases and frame intervals in microseconds', () => {
    const q = [0, 0, 0, 0, 0, 0, 0];
    const output = frameTable([{ q, ms: 12 }, { q, ms: 0 }], q);
    expect(output).toContain('using Target = ConceptArm::JointTarget<7>;');
    expect(output).toContain('Duration{12000.0f}');
  });
});
