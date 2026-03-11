import crypto from "crypto";

const CRM_DB_ID = "f7cabf3f-1aac-4b87-89e2-91a5431bd03d";

// Status progression — don't demote leads already further in the funnel
const STATUS_RANK = {
  "New Lead": 0,
  "Meeting Booked": 1,
  "Nurture": 2,
  "Proposal Sent": 3,
  "Closed Won": 4,
  "Closed Lost": 5,
  "Archive": 6,
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const NOTION_KEY = process.env.NOTION_API_KEY;
  const SLACK_URL = process.env.SLACK_WEBHOOK_URL;
  const TALLY_SECRET = process.env.TALLY_SIGNING_SECRET;

  if (!NOTION_KEY) {
    console.error("Missing NOTION_API_KEY");
    return res.status(500).json({ error: "Server misconfigured" });
  }

  // Verify Tally signature if secret is configured
  if (TALLY_SECRET) {
    const signature = req.headers["tally-signature"];
    const body = JSON.stringify(req.body);
    const expected = crypto
      .createHmac("sha256", TALLY_SECRET)
      .update(body)
      .digest("base64");
    if (!signature || signature !== expected) {
      return res.status(401).json({ error: "Invalid signature" });
    }
  }

  const { eventType, data } = req.body;
  if (eventType !== "FORM_RESPONSE") {
    return res.status(200).json({ skipped: true });
  }

  const fields = data?.fields || [];

  // Extract fields by matching labels (case-insensitive partial match)
  const name = getFieldValue(fields, "name") || "Unknown";
  const email = getFieldValue(fields, "email") || "";
  const company = getFieldValue(fields, "company") || "";
  const domain = getFieldValue(fields, "website") || getFieldValue(fields, "domain") || "";
  const intentPath = getChoiceText(fields, "what brings you") || getChoiceText(fields, "here for") || "";
  const needType = getChoiceText(fields, "need help") || getChoiceText(fields, "looking for") || "";
  const budget = getChoiceText(fields, "budget") || "";
  const timeline = getChoiceText(fields, "timeline") || "";
  const aiStatus = getChoiceText(fields, "ai system") || getChoiceText(fields, "ai tool") || "";
  const notes = getFieldValue(fields, "last q") || getFieldValue(fields, "note") || getFieldValue(fields, "anything else") || "";

  // Determine intent path category
  const intentLower = intentPath.toLowerCase();
  const isClient = intentLower.includes("client") || intentLower.includes("project") || intentLower.includes("hire");
  const isSponsorship = intentLower.includes("sponsor") || intentLower.includes("collab");

  // Under $1K budget = disqualified, skip everything
  const budgetLower = budget.toLowerCase();
  if (isClient && (budgetLower.includes("under") || budgetLower.includes("< 1") || budgetLower.includes("<1"))) {
    return res.status(200).json({ skipped: true, reason: "disqualified" });
  }

  // Sponsorship or Other path: Slack notification only, no CRM entry
  if (!isClient) {
    if (SLACK_URL) {
      const label = isSponsorship ? "Sponsorship Inquiry" : "Other Inquiry";
      const msg = isSponsorship
        ? `*${name}* (${email})\nCompany: ${company}\nType: ${intentPath}\nBudget: ${budget || "Not specified"}`
        : `*${name}* (${email}) — ${company}\nMessage: ${notes || "No details provided"}`;
      await postSlack(SLACK_URL, `${label}\n${msg}`);
    }
    return res.status(200).json({ ok: true, path: isSponsorship ? "sponsorship" : "other" });
  }

  // Client path: create/update CRM entry
  if (!email) {
    console.error("No email in Tally submission");
    return res.status(200).json({ skipped: true, reason: "no_email" });
  }

  // Build structured notes from BANT data
  const noteParts = [];
  if (needType) noteParts.push(`Need: ${needType}`);
  if (budget) noteParts.push(`Budget: ${budget}`);
  if (timeline) noteParts.push(`Timeline: ${timeline}`);
  if (aiStatus) noteParts.push(`AI Status: ${aiStatus}`);
  if (notes) noteParts.push(`Notes: ${notes}`);
  const structuredNotes = noteParts.join("\n");

  try {
    // Search CRM for existing contact by email
    const existing = await searchCrmByEmail(NOTION_KEY, email);

    if (existing) {
      // Update existing entry — don't demote status
      const currentStatus = existing.properties?.Status?.select?.name || "";
      const shouldUpdateStatus = (STATUS_RANK[currentStatus] ?? 99) > (STATUS_RANK["New Lead"] ?? 0)
        ? false : true;

      const updateProps = {};
      if (company) updateProps.Company = { rich_text: [{ text: { content: company } }] };
      if (domain) updateProps.domain = { url: domain.startsWith("http") ? domain : `https://${domain}` };
      if (structuredNotes) {
        updateProps.Notes = { rich_text: [{ text: { content: structuredNotes } }] };
      }
      if (shouldUpdateStatus) {
        updateProps.Status = { select: { name: "New Lead" } };
        updateProps.Source = { select: { name: "Inbound" } };
      }

      await updateNotionPage(NOTION_KEY, existing.id, updateProps);
    } else {
      // Create new CRM entry
      await createNotionPage(NOTION_KEY, {
        Name: { title: [{ text: { content: name } }] },
        Email: { email: email },
        Company: { rich_text: [{ text: { content: company } }] },
        domain: { url: domain ? (domain.startsWith("http") ? domain : `https://${domain}`) : null },
        Source: { select: { name: "Inbound" } },
        Status: { select: { name: "New Lead" } },
        "First Contacted": { date: { start: new Date().toISOString().split("T")[0] } },
        Notes: { rich_text: [{ text: { content: structuredNotes } }] },
      });
    }

    // Slack notification
    if (SLACK_URL) {
      const action = existing ? "Updated" : "New";
      const msg = [
        `${action} Inbound Lead`,
        `*${name}* (${email})`,
        company ? `Company: ${company}` : null,
        domain ? `Website: ${domain}` : null,
        needType ? `Need: ${needType}` : null,
        budget ? `Budget: ${budget}` : null,
        timeline ? `Timeline: ${timeline}` : null,
      ].filter(Boolean).join("\n");
      await postSlack(SLACK_URL, msg);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Tally webhook error:", err.message);
    return res.status(500).json({ error: "Failed to process submission" });
  }
}

// --- Helpers ---

function getFieldValue(fields, labelSubstring) {
  const lower = labelSubstring.toLowerCase();
  const field = fields.find((f) => f.label?.toLowerCase().includes(lower));
  if (!field) return "";
  if (Array.isArray(field.value)) {
    // For multiple choice, return the raw value (use getChoiceText for resolved text)
    return field.value.join(", ");
  }
  return typeof field.value === "string" ? field.value.trim() : String(field.value ?? "");
}

function getChoiceText(fields, labelSubstring) {
  const lower = labelSubstring.toLowerCase();
  const field = fields.find((f) => f.label?.toLowerCase().includes(lower));
  if (!field) return "";

  // For MULTIPLE_CHOICE / CHECKBOXES / DROPDOWN, resolve UUIDs to text
  if (field.options && Array.isArray(field.value)) {
    const optionMap = Object.fromEntries(field.options.map((o) => [o.id, o.text]));
    return field.value.map((id) => optionMap[id] || id).join(", ");
  }

  return typeof field.value === "string" ? field.value.trim() : String(field.value ?? "");
}

async function searchCrmByEmail(notionKey, email) {
  const response = await fetch(`https://api.notion.com/v1/databases/${CRM_DB_ID}/query`, {
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
  });
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
