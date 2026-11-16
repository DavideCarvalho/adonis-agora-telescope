import { describe, expect, it } from 'vitest';
import { QueryIgnoreMatcher } from '../../src/watchers/index.js';

describe('QueryIgnoreMatcher', () => {
  it('matches nothing when unconfigured', () => {
    const matcher = new QueryIgnoreMatcher();
    expect(matcher.empty).toBe(true);
    expect(matcher.ignores('select 1')).toBe(false);
  });

  it('a string is a prefix of the normalized template (case, spacing and literals ignored)', () => {
    const matcher = new QueryIgnoreMatcher(['select * from "durable_workflow_runs"']);
    expect(matcher.ignores('SELECT *\n  FROM "durable_workflow_runs" WHERE "id" = 42 LIMIT 1')).toBe(
      true,
    );
    // The quoted name in the pattern ends at its closing quote, so a longer table is not caught.
    expect(matcher.ignores('select * from "durable_workflow_runs_archive"')).toBe(false);
    expect(matcher.ignores('select * from "users"')).toBe(false);
  });

  it('a RegExp is tested against the normalized template, global flags included', () => {
    const matcher = new QueryIgnoreMatcher([/from "durable_\w+"/g]);
    // Twice: a /g pattern keeps lastIndex, which must not make the second call miss.
    expect(matcher.ignores('select * from "durable_runs" where id = 1')).toBe(true);
    expect(matcher.ignores('select * from "durable_runs" where id = 2')).toBe(true);
    expect(matcher.ignores('select * from "users"')).toBe(false);
  });

  it('ignoreTables matches the primary table of each kind of statement, schema optional', () => {
    const matcher = new QueryIgnoreMatcher([], ['Durable_Workflow_Runs', 'audit.log']);
    expect(matcher.ignores('select "id" from "durable_workflow_runs" where "id" = ?')).toBe(true);
    expect(matcher.ignores('select * from "public"."durable_workflow_runs"')).toBe(true);
    expect(matcher.ignores('insert into `durable_workflow_runs` (`id`) values (?)')).toBe(true);
    expect(matcher.ignores('update durable_workflow_runs set x = 1')).toBe(true);
    expect(matcher.ignores('delete from "durable_workflow_runs" where id = 1')).toBe(true);
    expect(matcher.ignores('select * from "audit"."log"')).toBe(true);
    // Another table that merely joins the ignored one is kept.
    expect(
      matcher.ignores('select * from "users" join "durable_workflow_runs" on 1 = 1'),
    ).toBe(false);
    expect(matcher.ignores('select * from "log"')).toBe(false);
  });
});
