import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  fetchAndMergeLabels,
  formatBuyTimeLocal,
  getUpsShipmentsForDay,
  isUpsShipment,
} from './dailyLabels';

describe('formatBuyTimeLocal', () => {
  it('returns a Bought: stamp for a timestamp', () => {
    const stamp = formatBuyTimeLocal(Date.UTC(2024, 0, 15, 12, 30, 0));
    expect(stamp.startsWith('Bought:')).toBe(true);
    expect(stamp.length).toBeGreaterThan('Bought:'.length + 5);
  });
});

describe('isUpsShipment', () => {
  it('matches carrier_id 5', () => {
    expect(isUpsShipment({ carrier_id: 5 })).toBe(true);
  });

  it('matches sub_carrier_id UPS', () => {
    expect(isUpsShipment({ sub_carrier_id: 'ups' })).toBe(true);
  });

  it('matches service_carrier_name', () => {
    expect(isUpsShipment({ service_carrier_name: 'UPS' })).toBe(true);
  });

  it('matches service_name / short_service_name containing ups', () => {
    expect(isUpsShipment({ service_name: 'UPS Ground' })).toBe(true);
    expect(isUpsShipment({ short_service_name: 'ups' })).toBe(true);
  });

  it('matches carrier object name/slug', () => {
    expect(isUpsShipment({ carrier: { name: 'United Parcel Service', slug: 'ups' } })).toBe(true);
    expect(isUpsShipment({ carrier: 'UPS' })).toBe(true);
  });

  it('matches 1Z tracking numbers', () => {
    expect(
      isUpsShipment({
        tracking_number: { tracking_number: '1Z999AA10123456784' },
      })
    ).toBe(true);
    expect(isUpsShipment({ tracking_number: '1zabc' })).toBe(true);
  });

  it('returns false for non-UPS shipments', () => {
    expect(isUpsShipment({ carrier_id: 29, service_name: 'USPS Priority' })).toBe(false);
    expect(isUpsShipment({ tracking_number: { tracking_number: '9400111899223344556677' } })).toBe(
      false
    );
  });
});

describe('getUpsShipmentsForDay', () => {
  it('filters to the target local day, deduplicates, and sorts by buy time', async () => {
    const dayStart = new Date(2024, 0, 15).getTime();
    const nextDayStart = new Date(2024, 0, 16).getTime();
    const iso = (ms: number) => new Date(ms).toISOString();
    const orders = [
      {
        allocations: [
          { shipment: { id: 8, carrier_id: 5, created_at: iso(dayStart + 12 * 60 * 60 * 1000) } },
          { shipment: { id: 3, sub_carrier_id: 'UPS', created_at: iso(dayStart + 2 * 60 * 60 * 1000) } },
          { shipment: { id: 2, carrier_id: 5, created_at: iso(dayStart - 1) } },
          { shipment: { id: 9, carrier_id: 5, created_at: iso(nextDayStart) } },
          { shipment: { id: 10, carrier_id: 29, created_at: iso(dayStart + 3 * 60 * 60 * 1000) } },
          { shipment: { id: 8, carrier_id: 5, created_at: iso(dayStart + 13 * 60 * 60 * 1000) } },
        ],
      },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return new Response(JSON.stringify(url.searchParams.get('page') === '1' ? orders : []), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await getUpsShipmentsForDay('test-key', '2024-01-15');

    expect(result.dateStr).toBe('2024-01-15');
    expect(result.shipments.map(({ id }) => id)).toEqual([3, 8]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstPageUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(firstPageUrl.searchParams.get('updated_at_min')).toBe(
      new Date(dayStart).toISOString().slice(0, 19).replace('T', ' ')
    );
  });

  it('rejects dates that do not use YYYY-MM-DD', async () => {
    await expect(getUpsShipmentsForDay('test-key', '2024/01/15')).rejects.toThrow(
      'Date must be YYYY-MM-DD'
    );
  });
});

describe('fetchAndMergeLabels', () => {
  it('merges PDFs returned in batches', async () => {
    const labelPdf = await PDFDocument.create();
    labelPdf.addPage();
    const labelBytes = await labelPdf.save();
    const labelBuffer = labelBytes.buffer.slice(
      labelBytes.byteOffset,
      labelBytes.byteOffset + labelBytes.byteLength
    ) as ArrayBuffer;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(labelBuffer, { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const shipments = Array.from({ length: 51 }, (_, index) => ({
      id: index + 1,
      createdAtMs: index,
    }));

    const mergedBytes = await fetchAndMergeLabels('test-key', shipments, undefined, false);
    const mergedPdf = await PDFDocument.load(mergedBytes);

    expect(mergedPdf.getPageCount()).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBatchUrl = new URL(String(fetchMock.mock.calls[0][0]));
    const secondBatchUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(firstBatchUrl.searchParams.getAll('shipment_ids[]')).toHaveLength(50);
    expect(secondBatchUrl.searchParams.getAll('shipment_ids[]')).toEqual(['51']);
  });
});
