import { Client } from "@notionhq/client";
import crypto from "crypto";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const CRM_DB_ID = "f7cabf3f-1aac-4b87-89e2-91a5431bd03d";
const WEBHOOK_SECRET = process.env.CAL_WEBHOOK_SECRET;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  // Require webhook secret — reject all requests if not configured
  if (!WEBHOOK_SECRET) {
    console.error("CAL_WEBHOOK_SECRET not configured");
    return res.status(500).json({ error: "Server misconfigured" });
  }

  // Verify HMAC signature from Cal.com
  const signature = req.headers["x-cal-signature-256"];
  const body = JSON.stringify(req.body);
  const expected = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(body)
    .digest("hex");
  if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const { triggerEvent, payload } = req.body;
  if (triggerEvent !== "BOOKING_CREATED") {
    return res.status(200).json({ skipped: true });
  }

  const attendee = payload.attendees?.[0] || {};
  const responses = payload.responses || {};

  // Build notes from "how they found us" + additional notes
  const howFound = responses.how_found?.value || "";
  const additionalNotes = responses.notes?.value || "";
  const notesParts = [];
  if (howFound) notesParts.push(`Found us: ${howFound}`);
  if (additionalNotes) notesParts.push(additionalNotes);
  const notes = notesParts.join("\n");

  // Extract domain/website
  const domain = responses.domain?.value || "";

  try {
    await notion.pages.create({
      parent: { database_id: CRM_DB_ID },
      properties: {
        Name: {
          title: [{ text: { content: attendee.name || "Unknown" } }],
        },
        Email: { email: attendee.email || null },
        Company: {
          rich_text: [{ text: { content: "" } }],
        },
        domain: { url: domain || null },
        Source: { select: { name: "Inbound" } },
        Status: { select: { name: "New Lead" } },
        "First Contacted": {
          date: { start: new Date().toISOString().split("T")[0] },
        },
        Notes: {
          rich_text: [{ text: { content: notes } }],
        },
      },
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Notion API error:", err.message);
    return res.status(500).json({ error: "Failed to create CRM entry" });
  }
}
