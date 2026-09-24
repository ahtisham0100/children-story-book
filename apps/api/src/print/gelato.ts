import { createDownloadUrl } from "../storage";
import { env } from "../env";

/**
 * Gelato answered with a 4xx. The request reached Gelato and was refused, so
 * no print order exists and a retry can't double-print. Fulfilment uses this
 * to tell a definite rejection apart from an ambiguous failure (network error,
 * timeout, 5xx), where an order may or may not have been created.
 */
export class GelatoRejectedError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Gelato order create rejected: ${status} ${body}`);
    this.name = "GelatoRejectedError";
  }
}

interface GelatoOrderInput {
  id: string;
  shippingName: string;
  shippingLine1: string;
  shippingLine2: string | null;
  shippingCity: string;
  shippingPostalCode: string;
  shippingCountry: string;
  items: { id: string; bookTitle: string; printPdfKey: string }[];
}

// WRITTEN FROM GELATO'S COMMONLY-DOCUMENTED v4 ORDER-CREATE API SHAPE. There is
// no Gelato account to verify this against yet (see the post-build checklist).
// Once you have API credentials, place one real test order and diff the actual
// required/returned fields against this function before relying on it —
// treat the URL, field names, and response shape below as a strong starting
// point, not a confirmed contract.
const GELATO_ORDERS_URL = "https://order.gelatoapis.com/v4/orders";

export async function submitOrderToGelato(order: GelatoOrderInput): Promise<{ gelatoOrderId: string }> {
  const items = await Promise.all(
    order.items.map(async (item) => ({
      itemReferenceId: item.id,
      productUid: env.GELATO_PRODUCT_UID,
      files: [{ type: "default", url: await createDownloadUrl(item.printPdfKey, 3600) }],
      quantity: 1,
    })),
  );

  const response = await fetch(GELATO_ORDERS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": env.GELATO_API_KEY ?? "",
    },
    body: JSON.stringify({
      orderReferenceId: order.id,
      currency: "EUR",
      items,
      shippingAddress: {
        firstName: order.shippingName,
        addressLine1: order.shippingLine1,
        addressLine2: order.shippingLine2 ?? undefined,
        city: order.shippingCity,
        postCode: order.shippingPostalCode,
        country: order.shippingCountry,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status >= 400 && response.status < 500) {
      throw new GelatoRejectedError(response.status, body);
    }
    throw new Error(`Gelato order create failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as { id?: string; orderId?: string };
  const gelatoOrderId = data.id ?? data.orderId;
  if (!gelatoOrderId) {
    throw new Error(`Gelato order create response had no id/orderId field: ${JSON.stringify(data)}`);
  }
  return { gelatoOrderId };
}

/**
 * Reads one order back from Gelato (GET /v4/orders/{id}) for the admin
 * "Sync from Gelato" button, which applies the status through the webhook's
 * own code path (src/orderStatusUpdate.ts).
 *
 * SAME CAVEAT AS submitOrderToGelato: written from Gelato's documented v4 API,
 * unverified against a real account. The status is read from
 * `fulfillmentStatus` (v4's name for it), falling back to `status`. An
 * unrecognised value is stored raw and doesn't change the order, so a wrong
 * guess here is visible in the timeline rather than corrupting the status.
 * Only the status is returned: the response also holds the shipping address,
 * which the admin API has no reason to copy anywhere.
 */
export async function getGelatoOrder(gelatoOrderId: string): Promise<{ status: string }> {
  const response = await fetch(`${GELATO_ORDERS_URL}/${encodeURIComponent(gelatoOrderId)}`, {
    method: "GET",
    headers: { "X-API-KEY": env.GELATO_API_KEY ?? "" },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Gelato order fetch failed: ${response.status} ${body.slice(0, 300)}`);
  }
  const data = (await response.json()) as { fulfillmentStatus?: unknown; status?: unknown };
  const status = typeof data.fulfillmentStatus === "string" ? data.fulfillmentStatus : data.status;
  if (typeof status !== "string" || !status) {
    throw new Error("Gelato order response had no fulfillmentStatus/status field.");
  }
  return { status };
}
