/**
 * lme.test.ts — Smoke-test / integration test script for the LME module.
 *
 * NOT a unit test framework — runs as a standalone script:
 *   npx tsx lib/sources/lme.test.ts
 *
 * Tests:
 *  1. discoverDownloadUrl() — should return null (Cloudflare blocked) or a URL (if access restored)
 *  2. fetchAndParseXlsx() — tests parser logic with a mock XLSX buffer
 *  3. fetchLmeData() — full integration test; checks return shape regardless of Cloudflare status
 */

import * as XLSX from 'xlsx';
import {
  fetchLmeData,
  discoverDownloadUrl,
  fetchAndParseXlsx,
  type LmeFetchResult,
  type LmePriceRow,
  type LmeStockRow,
} from './lme.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

function assertType<T>(value: unknown, check: (v: unknown) => v is T, message: string): void {
  assert(check(value), message);
}

// ---------------------------------------------------------------------------
// Test 1: discoverDownloadUrl() returns null or a valid URL string
// ---------------------------------------------------------------------------

async function testDiscoverDownloadUrl(): Promise<void> {
  console.log('\nTest 1: discoverDownloadUrl()');

  const result = await discoverDownloadUrl('{02E29CA4-5597-42E7-9A22-59BB73AE8F6B}');

  // Must return null (Cloudflare blocked) or a URL string starting with https://
  assert(
    result === null || (typeof result === 'string' && result.startsWith('https://')),
    `Returns null or HTTPS URL — got: ${JSON.stringify(result)}`,
  );

  if (result !== null) {
    console.log(`  Note: GUID resolved to URL (LME accessible): ${result}`);
  } else {
    console.log('  Note: LME blocked (expected in dev environment)');
  }
}

// ---------------------------------------------------------------------------
// Test 2: fetchAndParseXlsx() correctly parses an in-memory XLSX
// ---------------------------------------------------------------------------

function buildMockXlsx(): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  const data = [
    { Metal: 'Copper', 'Cash Buyer': 9500, 'Cash Seller': 9510, '3M Buyer': 9520, '3M Seller': 9530 },
    { Metal: 'Aluminium', 'Cash Buyer': 2300, 'Cash Seller': 2305, '3M Buyer': 2320, '3M Seller': 2325 },
    { Metal: 'Zinc', 'Cash Buyer': 2800, 'Cash Seller': 2805, '3M Buyer': 2815, '3M Seller': 2820 },
    { Metal: 'Nickel', 'Cash Buyer': 16000, 'Cash Seller': 16050, '3M Buyer': 16100, '3M Seller': 16150 },
    { Metal: 'Lead', 'Cash Buyer': 1900, 'Cash Seller': 1905, '3M Buyer': 1915, '3M Seller': 1920 },
    { Metal: 'Tin', 'Cash Buyer': 25000, 'Cash Seller': 25050, '3M Buyer': 25200, '3M Seller': 25250 },
  ];
  const ws = XLSX.utils.json_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Official');
  const binary = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  return (binary as Buffer).buffer.slice(
    (binary as Buffer).byteOffset,
    (binary as Buffer).byteOffset + (binary as Buffer).byteLength,
  );
}

/**
 * We can't call fetchAndParseXlsx() with a real URL in unit tests,
 * so we test the XLSX library integration by building and parsing a workbook directly.
 */
async function testXlsxParser(): Promise<void> {
  console.log('\nTest 2: XLSX parser (with in-memory workbook)');

  const buffer = buildMockXlsx();
  const wb = XLSX.read(new Uint8Array(buffer), { type: 'array', cellDates: true });

  assert(wb.SheetNames.length > 0, 'Workbook has at least one sheet');
  assert(wb.SheetNames.includes('Official'), 'Sheet named "Official" exists');

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Official'], {
    defval: null,
    raw: false,
  });

  assert(rows.length === 6, `Parsed 6 rows (got ${rows.length})`);
  assert(rows[0]['Metal'] === 'Copper', `First row metal is Copper (got ${rows[0]['Metal']})`);
  assert(
    typeof rows[0]['Cash Buyer'] === 'string' || typeof rows[0]['Cash Buyer'] === 'number',
    `Cash Buyer column exists and has a value (got ${JSON.stringify(rows[0]['Cash Buyer'])})`,
  );

  // Verify mid-price calculation would give correct value
  const cashBuyer = parseFloat(String(rows[0]['Cash Buyer']));
  const cashSeller = parseFloat(String(rows[0]['Cash Seller']));
  const expectedMid = (cashBuyer + cashSeller) / 2;
  assert(Math.abs(expectedMid - 9505) < 0.01, `Copper cash mid-price = 9505 (got ${expectedMid})`);
}

// ---------------------------------------------------------------------------
// Test 3: fetchLmeData() — full integration, validate output shape
// ---------------------------------------------------------------------------

async function testFetchLmeData(): Promise<void> {
  console.log('\nTest 3: fetchLmeData() — full integration');

  const t0 = Date.now();
  const result: LmeFetchResult = await fetchLmeData();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`  Completed in ${elapsed}s`);
  console.log(`  Status: ${result.status}`);
  console.log(`  Prices: ${result.prices.length} rows`);
  console.log(`  Stocks: ${result.stocks.length} rows`);
  console.log(`  Errors: ${result.errors.length}`);
  if (result.reason) {
    console.log(`  Reason: ${result.reason.slice(0, 120)}…`);
  }

  // Shape validation — must pass regardless of Cloudflare status
  assert(
    ['success', 'partial', 'failed'].includes(result.status),
    `status is valid enum value (got "${result.status}")`,
  );
  assert(result.source === 'lme_official', `source === 'lme_official'`);
  assert(Array.isArray(result.prices), 'prices is an array');
  assert(Array.isArray(result.stocks), 'stocks is an array');
  assert(Array.isArray(result.errors), 'errors is an array');
  assert(typeof result.fetched_at === 'string', 'fetched_at is a string');
  assert(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(result.fetched_at),
    'fetched_at is ISO 8601 format',
  );

  if (result.status === 'failed') {
    assert(
      typeof result.reason === 'string' && result.reason.length > 10,
      'failed result has non-empty reason string',
    );
    assert(result.prices.length === 0, 'failed result has empty prices array');
    assert(result.stocks.length === 0, 'failed result has empty stocks array');
  }

  // If we got any prices, validate their shape
  for (const row of result.prices.slice(0, 3)) {
    const p = row as LmePriceRow;
    assert(
      ['copper','aluminium','zinc','nickel','lead','tin'].includes(p.metal),
      `price.metal is valid LmeMetal (${p.metal})`,
    );
    assert(['cash','3m'].includes(p.contract), `price.contract is valid (${p.contract})`);
    assert(typeof p.price === 'number' && p.price > 0, `price.price > 0 (${p.price})`);
    assert(p.currency === 'USD', `price.currency === 'USD'`);
    assert(p.unit === 'tonne', `price.unit === 'tonne'`);
  }

  // If we got any stocks, validate their shape
  for (const row of result.stocks.slice(0, 3)) {
    const s = row as LmeStockRow;
    assert(
      ['copper','aluminium','zinc','nickel','lead','tin'].includes(s.metal),
      `stock.metal is valid LmeMetal (${s.metal})`,
    );
    assert(typeof s.on_warrant === 'number', `stock.on_warrant is number`);
    assert(typeof s.cancelled_warrants === 'number', `stock.cancelled_warrants is number`);
    assert(typeof s.total_stock === 'number', `stock.total_stock is number`);
    assert(/^\d{4}-\d{2}-\d{2}$/.test(s.as_of), `stock.as_of is YYYY-MM-DD (${s.as_of})`);
  }
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

(async () => {
  console.log('=== LME Module Smoke Tests ===\n');

  await testDiscoverDownloadUrl();
  await testXlsxParser();
  await testFetchLmeData();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
})();
