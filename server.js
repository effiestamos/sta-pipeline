const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SPREADSHEET_ID = '11YuQ4xweAflQmiREbaC1IbC_8heTt9UN3FHQy-ry0EE';

const CLOSERS = [
  'Ammar Elmahalawy',
  'Jack Watson', 
  'Apolo',
  'Dave Bateman',
  'Fox Macpherson',
  'Scott Fury'
];

const STATUS_OPTIONS = [
  'Closed', 'Deposit', 'DQ', 'FDQ',
  'Partner | Multiple Partners',
  'Sticker Shock | Investment Issue',
  'Iffy / Feeling it Out / Not Sure',
  'DIM - Do It Myself',
  'Fact Finder / Coaching / Researching',
  'Timing / Logistics',
  'Need to Pitch / Offer',
  'Not Moving Forward',
  'Y - Long Follow Up',
  'Re-Offer',
  'Burned'
];

const TEMP_OPTIONS = ['Cold', 'Cool', 'Warm', 'Hot', '🔥🔥🔥'];

function getGoogleAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth;
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/closers', (req, res) => {
  res.json(CLOSERS);
});

app.post('/api/parse-eod', async (req, res) => {
  const { eodText, closerName } = req.body;
  
  if (!eodText || !closerName) {
    return res.status(400).json({ error: 'Missing EOD text or closer name' });
  }

  try {
    const prompt = `You are a sales data extraction assistant. Parse this EOD (End of Day) report from closer "${closerName}" and extract structured data.

EOD TEXT:
${eodText}

RULES:
1. Skip cancelled or no-show FIRST TIME calls entirely - do not include them
2. Only include prospects where the call actually happened OR follow-up calls (even if they no-showed, since they're already in the pipeline)
3. A follow-up call is identified by "FUP", "fup", "follow up", or "follow-up" appearing RIGHT AFTER the prospect name (e.g. "Grant - FUP - Closed" or "Juliana - fup - needs to sort...")
4. Do NOT treat "FUP" inside the notes/summary as a follow-up call indicator
5. For closed deals, Offered is always YES
6. Temperature rules: if a follow-up is booked (even just "FUP next week"), temperature is minimum Warm
7. "Super bought in" + FUP booked = offer was likely made
8. "Trial" mention implies main offer was made first
9. If stats show more offers than you can confirm from notes, flag the discrepancy
10. If stats show a FUP close but no closed prospect is named, flag it as MISSING_CLOSE
11. EOD notes must be copied VERBATIM - do not edit, clean up, or paraphrase
12. Extract the date from the EOD

STATUS OPTIONS: ${STATUS_OPTIONS.join(', ')}
TEMP OPTIONS: ${TEMP_OPTIONS.join(', ')}

Return ONLY valid JSON in this exact format:
{
  "date": "MM/DD/YYYY",
  "closer": "${closerName}",
  "prospects": [
    {
      "name": "Prospect Name",
      "isFollowUp": false,
      "eodNotes": "VERBATIM notes from EOD",
      "suggestedStatus": "one of the STATUS OPTIONS",
      "suggestedTemp": "one of the TEMP OPTIONS",
      "offered": "Yes|No|Unknown",
      "nextFollowUpDate": "MM/DD/YYYY or null",
      "setter": "setter name or null",
      "flags": ["list of flags if any"]
    }
  ],
  "stats": {
    "scheduledConsults": 0,
    "liveConsults": 0,
    "offersMade": 0,
    "oneCallCloses": 0,
    "followUpsScheduled": 0,
    "followUpsTaken": 0,
    "followUpCloses": 0,
    "totalFERevenue": 0,
    "totalFECollected": 0
  },
  "skipped": ["list of skipped prospect names and reason"],
  "globalFlags": ["MISSING_CLOSE if stats show FUP close but no name found", "OFFER_MISMATCH if offer count doesn't match"]
}`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const responseText = message.content[0].text;
    const cleanJson = responseText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleanJson);
    
    res.json(parsed);
  } catch (error) {
    console.error('Parse error:', error);
    res.status(500).json({ error: 'Failed to parse EOD: ' + error.message });
  }
});

app.post('/api/save-to-sheets', async (req, res) => {
  const { prospects, stats, date, closerName } = req.body;
  
  try {
    const auth = getGoogleAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    
    const tabName = closerName.toUpperCase();
    
    for (const prospect of prospects) {
      const rowData = [
        date,
        closerName,
        prospect.name + (prospect.email ? ` | ${prospect.email}` : ''),
        prospect.setter || '',
        prospect.eodNotes,
        prospect.nextFollowUpDate || '',
        date,
        prospect.offered,
        prospect.suggestedTemp,
        prospect.suggestedStatus,
        ''
      ];

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${tabName}!A:K`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [rowData] },
      });
    }

    res.json({ success: true, message: `Saved ${prospects.length} prospects to ${tabName} tab` });
  } catch (error) {
    console.error('Sheets error:', error);
    res.status(500).json({ error: 'Failed to save to sheets: ' + error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});