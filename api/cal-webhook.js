import crypto from "crypto";

const CRM_DB_ID = "f7cabf3f-1aac-4b87-89e2-91a5431bd03d";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const WEBHOOK_SECRET = process.env.CAL_WEBHOOK_SECRET;
  const NOTION_KEY = process.env.NOTION_API_KEY;
  const SLACK_URL = process.env.SLACK_WEBHOOK_URL;

  if (!WEBHOOK_SECRET || !NOTION_KEY) {
    console.error("Missing env vars:", {
      hasWebhookSecret: !!WEBHOOK_SECRET,
      hasNotionKey: !!NOTION_KEY,
    });
    return res.status(500).json({ error: "Server misconfigured" });
  }

  // Verify HMAC signature from Cal.com
  const signature = req.headers["x-cal-signature-256"];
  const body = JSON.stringify(req.body);
  const expected = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(body)
    .digest("hex");
  if (
    !signature ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const { triggerEvent, payload } = req.body;
  if (triggerEvent !== "BOOKING_CREATED") {
    return res.status(200).json({ skipped: true });
  }

  const attendee = payload.attendees?.[0] || {};
  const attendeeName = attendee.name || "Unknown";
  const attendeeEmail = attendee.email || "";
  const startTime = payload.startTime || "";
  const location = payload.location || "";

  if (!attendeeEmail) {
    console.error("No attendee email in Cal.com booking");
    return res.status(200).json({ skipped: true, reason: "no_email" });
  }

  try {
    // Search CRM for existing contact by email
    const existing = await searchCrmByEmail(NOTION_KEY, attendeeEmail);

    if (existing) {
      // Update existing entry to "Meeting Booked" — only if currently "New Lead"
      const currentStatus = existing.properties?.Status?.select?.name || "";
      if (currentStatus === "New Lead") {
        await updateNotionPage(NOTION_KEY, existing.id, {
          Status: { select: { name: "Meeting Booked" } },
        });
      }
    } else {
      // Fallback: create new entry (direct Cal.com booking that bypassed Tally)
      await createNotionPage(NOTION_KEY, {
        Name: { title: [{ text: { content: attendeeName } }] },
        Email: { email: attendeeEmail },
        Company: { rich_text: [{ text: { content: "" } }] },
        Source: { select: { name: "Inbound" } },
        Status: { select: { name: "Meeting Booked" } },
        "First Contacted": {
          date: { start: new Date().toISOString().split("T")[0] },
        },
      });
    }

    // Slack notification
    if (SLACK_URL) {
      let when = "";
      if (startTime) {
        try {
          when = new Date(startTime).toLocaleString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZone: "America/Los_Angeles",
          });
        } catch {
          when = startTime;
        }
      }
      const msg = [
        "Meeting Booked",
        `*${attendeeName}* (${attendeeEmail})`,
        when ? `When: ${when} PT` : null,
        location ? `Where: ${location}` : null,
        existing ? null : "(new contact — bypassed Tally)",
      ].filter(Boolean).join("\n");
      await postSlack(SLACK_URL, msg);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Cal webhook error:", err.message);
    return res.status(500).json({ error: "Failed to process booking" });
  }
}

// --- Helpers ---

async function searchCrmByEmail(notionKey, email) {
  const response = await fetch(
    `https://api.notion.com/v1/databases/${CRM_DB_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${notionKey}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: { property: "Email", email: { equals: email } },
        page_size: 1,
      }),
    }
  );
  if (!response.ok) {
    console.error("Notion search error:", await response.text());
    return null;
  }
  const data = await response.json();
  return data.results?.[0] || null;
}

async function createNotionPage(notionKey, properties) {
  const response = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${notionKey}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { database_id: CRM_DB_ID },
      properties,
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    console.error("Notion create error:", err);
    throw new Error(`Notion create failed: ${err}`);
  }
  return response.json();
}

async function updateNotionPage(notionKey, pageId, properties) {
  const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${notionKey}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties }),
  });
  if (!response.ok) {
    const err = await response.text();
    console.error("Notion update error:", err);
    throw new Error(`Notion update failed: ${err}`);
  }
  return response.json();
}

async function postSlack(webhookUrl, text) {
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error("Slack notification failed:", err.message);
  }
}
