import { describe, it, expect } from 'vitest';
import { extractWikiLinks, buildStemLookup, resolveLink } from '../src/lib/wiki-links.js';

describe('extractWikiLinks', () => {
  it('extracts bare wiki links', () => {
    const links = extractWikiLinks('See [[Alice Smith]] for details.');
    expect(links).toEqual([{ raw: 'Alice Smith', display: null }]);
  });

  it('extracts path-qualified links', () => {
    const links = extractWikiLinks('Uses [[Concepts/Widget Theory]] extensively.');
    expect(links).toEqual([{ raw: 'Concepts/Widget Theory', display: null }]);
  });

  it('extracts pipe-aliased links', () => {
    const links = extractWikiLinks('The [[Concepts/Widget Theory|widget framework]] works.');
    expect(links).toEqual([{ raw: 'Concepts/Widget Theory', display: 'widget framework' }]);
  });

  it('ignores links inside code blocks', () => {
    const md = '```\n[[not a link]]\n```\nBut [[real link]] is.';
    const links = extractWikiLinks(md);
    expect(links).toEqual([{ raw: 'real link', display: null }]);
  });

  it('ignores embedded image links', () => {
    const links = extractWikiLinks('Look at ![[photo.png]] and [[real link]].');
    expect(links).toEqual([{ raw: 'real link', display: null }]);
  });

  it('extracts multiple links from one paragraph', () => {
    const links = extractWikiLinks('Both [[Alice]] and [[Bob]] agreed on [[Plan]].');
    expect(links).toHaveLength(3);
  });

  it('ignores links inside inline code', () => {
    const links = extractWikiLinks('Use `[[not a link]]` but [[real link]] works.');
    expect(links).toEqual([{ raw: 'real link', display: null }]);
  });

  it('handles empty link gracefully', () => {
    const links = extractWikiLinks('An empty [[]] link.');
    // FTS pattern requires at least one char inside, so empty [[]] should not match
    expect(links).toHaveLength(0);
  });
});

describe('buildStemLookup', () => {
  it('maps filename stems to full paths', () => {
    const paths = ['People/Alice Smith.md', 'Concepts/Widget Theory.md'];
    const lookup = buildStemLookup(paths);
    expect(lookup.get('Alice Smith')).toEqual(['People/Alice Smith.md']);
    expect(lookup.get('Widget Theory')).toEqual(['Concepts/Widget Theory.md']);
  });

  it('detects ambiguous stems', () => {
    const paths = ['People/Alice Smith.md', 'Archive/Alice Smith.md'];
    const lookup = buildStemLookup(paths);
    expect(lookup.get('Alice Smith')).toHaveLength(2);
  });
});

describe('resolveLink', () => {
  const allPaths = [
    'People/Alice Smith.md',
    'People/Bob Jones.md',
    'Concepts/Widget Theory.md',
  ];
  const lookup = buildStemLookup(allPaths);

  it('resolves bare name to unique path', () => {
    expect(resolveLink('Alice Smith', lookup)).toBe('People/Alice Smith.md');
  });

  it('resolves path-qualified link directly', () => {
    expect(resolveLink('People/Bob Jones', lookup)).toBe('People/Bob Jones.md');
  });

  it('returns null for unresolvable links (stub nodes)', () => {
    expect(resolveLink('Nonexistent Page', lookup)).toBeNull();
  });

  it('resolves ambiguous stem with path hint', () => {
    const paths = ['Dir1/Shared.md', 'Dir2/Shared.md'];
    const ambigLookup = buildStemLookup(paths);
    expect(resolveLink('Dir1/Shared', ambigLookup)).toBe('Dir1/Shared.md');
    expect(resolveLink('Dir2/Shared', ambigLookup)).toBe('Dir2/Shared.md');
  });

  it('falls back to first match for ambiguous bare name', () => {
    const paths = ['Dir1/Shared.md', 'Dir2/Shared.md'];
    const ambigLookup = buildStemLookup(paths);
    // Should pick first (with console.warn) rather than returning null
    const result = resolveLink('Shared', ambigLookup);
    expect(result).toBe('Dir1/Shared.md');
  });

  it('falls back when ambiguous path-qualified raw has no matching directory', () => {
    const paths = ['Dir1/Shared.md', 'Dir2/Shared.md'];
    const ambigLookup = buildStemLookup(paths);
    // raw has "/" but no candidate starts with "Dir3/Shared" — exercises the
    // "match === undefined" branch at wiki-links.ts:77-78 and falls through to warn.
    const result = resolveLink('Dir3/Shared', ambigLookup);
    expect(result).toBe('Dir1/Shared.md');
  });

  it('uses explicit allPathsSet when provided', () => {
    const paths = ['People/Alice Smith.md'];
    const lookup = buildStemLookup(paths);
    // Passing allPathsSet exercises the left-hand side of the ?? on line 60.
    const result = resolveLink('People/Alice Smith', lookup, new Set(paths));
    expect(result).toBe('People/Alice Smith.md');
  });
});
