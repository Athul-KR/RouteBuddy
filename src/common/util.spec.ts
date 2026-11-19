import { distanceToLine, haversine, inQuietHours, toMinutes } from './util.js';

describe('util', () => {
  it('converts HH:mm to minutes', () => {
    expect(toMinutes('00:00')).toBe(0);
    expect(toMinutes('08:30')).toBe(510);
  });

  it('handles quiet hours that cross midnight', () => {
    expect(inQuietHours(toMinutes('23:00'), '22:00', '07:00')).toBe(true);
    expect(inQuietHours(toMinutes('06:59'), '22:00', '07:00')).toBe(true);
    expect(inQuietHours(toMinutes('07:00'), '22:00', '07:00')).toBe(false);
    expect(inQuietHours(toMinutes('13:00'), '12:00', '14:00')).toBe(true);
  });

  it('measures distance in metres', () => {
    // About 1.11 km per 0.01 degree of latitude.
    expect(haversine([76.27, 9.93], [76.27, 9.94])).toBeGreaterThan(1100);
    expect(haversine([76.27, 9.93], [76.27, 9.94])).toBeLessThan(1120);
  });

  it('matches an incident to a route only when it is close to the line', () => {
    const line: [number, number][] = [[76.27, 9.93], [76.30, 9.93]];
    expect(distanceToLine([76.285, 9.9305], line)).toBeLessThan(120); // ~55 m off the road
    expect(distanceToLine([76.285, 9.94], line)).toBeGreaterThan(1000); // ~1.1 km away
  });
});

describe('mainRoad', () => {
  it('picks the street a route spends most distance on', async () => {
    const { mainRoad } = await import('../providers/providers.js');
    const ins = [
      { routeOffsetInMeters: 0, street: 'Start Lane' },
      { routeOffsetInMeters: 100, street: 'Thenmala Road' },
      { routeOffsetInMeters: 2200, street: 'Gokul Road' },
      { routeOffsetInMeters: 2500, street: 'M C Road' },
    ];
    expect(mainRoad(ins, 4000)).toBe('Thenmala Road');
    expect(mainRoad([], 4000)).toBeUndefined();
  });
});

import { splitSource } from '../providers/providers.js';

describe('splitSource', () => {
  it('splits a Google News headline into title and publisher', () => {
    expect(splitSource('മഴ ശക്തമാകും - Manorama Online')).toEqual(['മഴ ശക്തമാകും', 'Manorama Online']);
  });
  it('keeps the title whole when the feed names its source', () => {
    expect(splitSource('Kochi - Metro update', 'The Hindu')).toEqual(['Kochi - Metro update', 'The Hindu']);
  });
});

import { checkpoints, tripMinutes } from '../providers/providers.js';

describe('tripMinutes', () => {
  it('times cycling from distance, not from car traffic', () => {
    // TomTom's bicycle mode said 22 min for 7.1 km (car speed); at 15 km/h it is 28 min.
    expect(tripMinutes('cycle', 22 * 60, 7100)).toBe(28);
    expect(tripMinutes('car', 22 * 60, 7400)).toBe(22);
    expect(tripMinutes('walk', 85 * 60, 4500)).toBe(60);
  });
});

describe('checkpoints', () => {
  it('spaces points along a path and always keeps both ends', () => {
    const line: [number, number][] = Array.from({ length: 101 }, (_, i) => [76.2 + i * 0.0001, 9.9]); // ~1.1 km east
    const cps = checkpoints(line, 250, 60);
    expect(cps[0].i).toBe(0);
    expect(cps.at(-1)!.i).toBe(100);
    expect(cps.length).toBeGreaterThanOrEqual(4);
    expect(cps.length).toBeLessThanOrEqual(6);
    expect(cps[1].heading).toBe(90);
  });
  it('never returns more than the maximum', () => {
    const line: [number, number][] = Array.from({ length: 2000 }, (_, i) => [76.2 + i * 0.001, 9.9]);
    expect(checkpoints(line, 250, 60).length).toBeLessThanOrEqual(60);
  });
});

import { itemImage } from '../providers/providers.js';

describe('itemImage', () => {
  it('reads media:content, media:thumbnail, enclosure and inline <img>', () => {
    expect(itemImage({ mediaContent: [{ $: { url: 'https://a.example/1.jpg', medium: 'image' } }] })).toBe('https://a.example/1.jpg');
    expect(itemImage({ mediaThumbnail: { $: { url: 'https://img.example/x.webp?f=16:9&amp;w=900' } } })).toBe('https://img.example/x.webp?f=16:9&w=900');
    expect(itemImage({ enclosure: { url: 'https://e.example/2.png', type: 'image/png' } })).toBe('https://e.example/2.png');
    expect(itemImage({ content: '<p><img class="x" src="https://c.example/3.jpg"></p>' })).toBe('https://c.example/3.jpg');
  });
  it('ignores non-image media, plain http and missing images', () => {
    expect(itemImage({ mediaContent: [{ $: { url: 'https://v.example/clip.mp4', medium: 'video' } }] })).toBeUndefined();
    expect(itemImage({ enclosure: { url: 'http://insecure.example/4.jpg' } })).toBeUndefined();
    expect(itemImage({})).toBeUndefined();
  });
});

import { summaryOf } from '../providers/providers.js';

describe('summaryOf', () => {
  it('strips tags and the Read more link, and keeps short summaries whole', () => {
    expect(summaryOf('<p>നടുറോഡിൽ യുവാവിനെ ആക്രമിച്ചു. പോലീസ് അന്വേഷണം തുടങ്ങി.<a class="moretag" href="x"> ... Read more</a></p>'))
      .toBe('നടുറോഡിൽ യുവാവിനെ ആക്രമിച്ചു. പോലീസ് അന്വേഷണം തുടങ്ങി.');
  });
  it('cuts long text on a word and drops empty ones', () => {
    const s = summaryOf('word '.repeat(100))!;
    expect(s.length).toBeLessThanOrEqual(281);
    expect(s.endsWith('…')).toBe(true);
    expect(summaryOf('<p> </p>')).toBeUndefined();
  });
});

import { repairXml } from '../providers/providers.js';

describe('repairXml', () => {
  it('escapes bare ampersands and keeps real entities', () => {
    expect(repairXml('<t>Kerala & India &amp; World &#8217; &#x200d; &nbsp;</t>')).toBe('<t>Kerala &amp; India &amp; World &#8217; &#x200d; &nbsp;</t>');
  });
});

import { isPolitical } from '../providers/providers.js';

describe('isPolitical', () => {
  it('spots political stories in English and Malayalam', () => {
    expect(isPolitical('UDF sub-committee to discuss liquor policy draft before CM')).toBe(true);
    expect(isPolitical('Pinarayi Vijayan meets Governor')).toBe(true);
    expect(isPolitical('മന്ത്രിസഭാ യോഗത്തിൽ നിർണായക തീരുമാനം')).toBe(true);
    expect(isPolitical('പിഎം ശ്രീയിൽ ഒപ്പിട്ടത് അബദ്ധം: എല്‍ഡിഎഫ് കണ്‍വീനര്‍')).toBe(true);
  });
  it('leaves other stories out', () => {
    expect(isPolitical('Kerala Blasters win 2-0 at home')).toBe(false);
    expect(isPolitical('കോഴിക്കോട് ബീച്ചിൽ കനത്ത മഴ')).toBe(false);
  });
});
