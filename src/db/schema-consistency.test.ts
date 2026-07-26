import { index, pgTable, text } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  assertSchemaForeignKeyIndexes,
  findUnindexedForeignKeyColumns,
  findUnindexedForeignKeyColumnsInSchema,
  getIndexedColumnSqlNames,
  isForeignKeyShapedColumn,
} from "./schema-fk-indexes.js";
import * as schema from "./schema.js";

describe("isForeignKeyShapedColumn", () => {
  it("recognizes relational Id columns", () => {
    expect(isForeignKeyShapedColumn("agreementId", "agreement_id", false)).toBe(true);
    expect(isForeignKeyShapedColumn("profileId", "profile_id", false)).toBe(true);
  });

  it("ignores primary keys, tax identifiers, and non-relational columns", () => {
    expect(isForeignKeyShapedColumn("id", "id", true)).toBe(false);
    expect(isForeignKeyShapedColumn("taxId", "tax_id", false)).toBe(false);
    expect(isForeignKeyShapedColumn("eventIndex", "event_index", false)).toBe(false);
  });
});

describe("findUnindexedForeignKeyColumns", () => {
  const tableWithoutFkIndex = pgTable("schema_consistency_gap_fixture", {
    id: text("id").primaryKey(),
    agreementId: text("agreement_id").notNull(),
  });

  const tableWithFkIndex = pgTable(
    "schema_consistency_ok_fixture",
    {
      id: text("id").primaryKey(),
      agreementId: text("agreement_id").notNull(),
    },
    (table) => ({
      agreementIdIdx: index("schema_consistency_ok_fixture_agreement_id_idx").on(table.agreementId),
    }),
  );

  it("flags FK-shaped columns that lack an index", () => {
    expect(findUnindexedForeignKeyColumns(tableWithoutFkIndex)).toEqual([
      {
        tableName: "schema_consistency_gap_fixture",
        columnName: "agreement_id",
        jsName: "agreementId",
      },
    ]);
  });

  it("passes when the FK column is indexed", () => {
    expect(findUnindexedForeignKeyColumns(tableWithFkIndex)).toEqual([]);
  });

  it("assertSchemaForeignKeyIndexes fails with a clear message for gaps", () => {
    expect(() =>
      assertSchemaForeignKeyIndexes({ tableWithoutFkIndex } as Record<string, unknown>),
    ).toThrow(/Foreign-key-shaped column\(s\) missing an index: schema_consistency_gap_fixture\.agreement_id \(agreementId\)/);
  });
});

describe("schema.ts foreign-key index consistency", () => {
  it("indexes every FK-shaped column exported from schema.ts", () => {
    const unindexed = findUnindexedForeignKeyColumnsInSchema(schema as Record<string, unknown>);
    expect(unindexed).toEqual([]);
  });

  it("assertSchemaForeignKeyIndexes succeeds on the production schema", () => {
    expect(() => assertSchemaForeignKeyIndexes(schema as Record<string, unknown>)).not.toThrow();
  });

  it("covers billing profile owner_address via unique constraint indexing", () => {
    const indexed = getIndexedColumnSqlNames(schema.billingProfiles);
    expect(indexed.has("owner_address")).toBe(true);
  });
});
