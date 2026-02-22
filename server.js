/**
 * Pacific Charter Services — Vapi Webhook Server
 * Handles tool calls from Vapi voice agent to:
 * 1. Check availability on Checkfront
 * 2. Create bookings on Checkfront
 * 3. Send confirmation via email/SMS
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
// Email/SMS will be handled via HTTPS API (Render blocks SMTP)

// --- Config ---
const PORT = process.env.PORT || 3456;
const CF_HOST = 'pacific-charter-services.manage.na1.bookingplatform.app';
const CF_API_KEY = 'b22536d599b19fb4f3bdc1c5301f4c6765b09baf';
const CF_API_SECRET = 'ae022730cb77fcdcebf4a9f07f548a3fbb75169046873cee8db0b521a73308f9';
const CF_AUTH = Buffer.from(`${CF_API_KEY}:${CF_API_SECRET}`).toString('base64');

// Item ID mapping
const ITEMS = {
  'lingcod': { id: 99316, name: 'Deep Water Lingcod & Rock Fish', price: 225 },
  'offshore': { id: 99317, name: 'Offshore Rockfish Trip (Long-Leader)', price: 250 },
  'halibut': { id: 99413, name: 'All-Day Halibut Trip', price: 350 },
  'halibut_combo': { id: 99414, name: 'Halibut & Lingcod Combo', price: 350 },
  'tuna': { id: 99418, name: 'Albacore Tuna Charter', price: 400 },
  'crabbing': { id: 99453, name: 'Dungeness Ocean Crabbing & Scenic Tour', price: 100 },
};

// --- Helpers ---
function cfRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: CF_HOST,
      path: `/api/3.0/${path}`,
      method,
      headers: {
        'Authorization': `Basic ${CF_AUTH}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function matchTrip(tripName) {
  const t = (tripName || '').toLowerCase();
  if (t.includes('tuna') || t.includes('albacore')) return 'tuna';
  if (t.includes('halibut') && t.includes('combo')) return 'halibut_combo';
  if (t.includes('halibut')) return 'halibut';
  if (t.includes('offshore') || t.includes('long leader') || t.includes('long-leader')) return 'offshore';
  if (t.includes('crab')) return 'crabbing';
  if (t.includes('lingcod') || t.includes('rockfish') || t.includes('rock fish') || t.includes('bottom') || t.includes('deep water')) return 'lingcod';
  return null;
}

function formatDate(dateStr) {
  // Handle relative dates
  const t = (dateStr || '').toLowerCase().trim();
  const now = new Date();
  
  // "this saturday", "this sunday", "this weekend", "saturday", "sunday", etc.
  const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  for (let i = 0; i < dayNames.length; i++) {
    if (t.includes(dayNames[i])) {
      const today = now.getDay();
      let diff = i - today;
      if (diff <= 0) diff += 7;
      const d = new Date(now);
      d.setDate(d.getDate() + diff);
      return fmtDate(d);
    }
  }
  
  if (t.includes('today')) return fmtDate(now);
  if (t.includes('tomorrow')) {
    const d = new Date(now); d.setDate(d.getDate() + 1); return fmtDate(d);
  }
  if (t.includes('this weekend')) {
    // Next Saturday
    const today = now.getDay();
    let diff = 6 - today;
    if (diff <= 0) diff += 7;
    const d = new Date(now); d.setDate(d.getDate() + diff); return fmtDate(d);
  }

  // Try standard parsing — add current year if no year present
  let str = dateStr;
  if (!/\d{4}/.test(str)) {
    str = str + ', ' + now.getFullYear();
  }
  const d = new Date(str);
  if (isNaN(d)) return null;
  // If the date is in the past, try next year
  if (d < now) {
    const d2 = new Date(dateStr + ', ' + (now.getFullYear() + 1));
    if (!isNaN(d2)) return fmtDate(d2);
  }
  return fmtDate(d);
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// --- Tool Handlers ---

async function findNextAvailable({ trip_type, guests, start_from }) {
  const key = matchTrip(trip_type);
  if (!key) return { error: `Unknown trip type: ${trip_type}` };

  const item = ITEMS[key];
  const numGuests = parseInt(guests) || 1;
  
  // Check a 30-day range from start_from (or today)
  const startDate = start_from ? new Date(start_from) : new Date();
  if (isNaN(startDate)) startDate = new Date();
  
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + 30);
  
  const startStr = fmtDate(startDate);
  const endStr = fmtDate(endDate);
  
  const data = await cfRequest('GET', `item/${item.id}?start_date=${startStr}&end_date=${endStr}&param%5Bguest%5D=${numGuests}`);
  
  const rate = data?.item?.rate;
  const dates = rate?.dates || {};
  
  const available = [];
  for (const [dateKey, info] of Object.entries(dates)) {
    if (info.status === 'A' && (info.stock?.A || 0) >= numGuests) {
      available.push({
        date: dateKey,
        formatted: `${dateKey.slice(0,4)}-${dateKey.slice(4,6)}-${dateKey.slice(6,8)}`,
        spots: info.stock?.A || 0,
      });
    }
    if (available.length >= 5) break; // Return first 5 available dates
  }
  
  if (available.length === 0) {
    return {
      available: false,
      trip: item.name,
      message: `No availability found for ${item.name} in the next 30 days for ${numGuests} guests. Would you like to try a different trip or check further out?`,
    };
  }
  
  // Format nicely
  const dateList = available.map(a => {
    const d = new Date(a.formatted + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  });
  
  return {
    available: true,
    trip: item.name,
    guests: numGuests,
    next_dates: dateList,
    first_available: dateList[0],
    price_per_person: item.price,
    message: `The next available dates for ${item.name} with ${numGuests} guests are: ${dateList.join(', ')}. $${item.price} per person.`,
  };
}

async function lookupBooking({ customer_name, customer_phone, customer_email, confirmation_code }) {
  // If we have a confirmation code, look it up directly
  if (confirmation_code) {
    // Confirmation codes are like AKSM-210226, but the booking_id is numeric
    // Search through recent bookings
    const data = await cfRequest('GET', 'booking?limit=100&order_by=booking_id&order=DESC');
    const bookings = data?.['booking/index'] || {};
    for (const [k, b] of Object.entries(bookings)) {
      if (b.code === confirmation_code.toUpperCase()) {
        return {
          found: true,
          booking_id: b.booking_id,
          code: b.code,
          status: b.status_name,
          customer_name: b.customer_name,
          customer_email: b.customer_email,
          total: b.total,
          date: b.date_desc,
          trip: b.summary,
          message: `Found your booking! Code: ${b.code}, ${b.summary} on ${b.date_desc}. Status: ${b.status_name}. Total: $${b.total}.`,
        };
      }
    }
  }

  // Search by name, phone, or email
  const searchTerm = (customer_name || customer_phone || customer_email || '').toLowerCase();
  if (!searchTerm) {
    return { found: false, error: 'Please provide a name, phone number, email, or confirmation code to look up the booking.' };
  }

  // Get recent bookings and search
  const data = await cfRequest('GET', 'booking?limit=100&order_by=booking_id&order=DESC');
  const bookings = data?.['booking/index'] || {};
  const matches = [];

  for (const [k, b] of Object.entries(bookings)) {
    const name = (b.customer_name || '').toLowerCase();
    const email = (b.customer_email || '').toLowerCase();
    const phone = (b.customer_phone || '').replace(/\D/g, '');
    const searchClean = searchTerm.replace(/\D/g, '');

    if (
      (customer_name && name.includes(customer_name.toLowerCase())) ||
      (customer_email && email.includes(customer_email.toLowerCase())) ||
      (customer_phone && phone.includes(searchClean))
    ) {
      matches.push({
        booking_id: b.booking_id,
        code: b.code,
        status: b.status_name,
        customer_name: b.customer_name,
        customer_email: b.customer_email,
        total: b.total,
        date: b.date_desc,
        trip: b.summary,
      });
    }
  }

  if (matches.length === 0) {
    return { found: false, message: 'I could not find a booking matching that information. Could you try a different name, phone number, or email?' };
  }

  if (matches.length === 1) {
    const b = matches[0];
    return {
      found: true,
      ...b,
      message: `Found your booking! Code: ${b.code}, ${b.trip} on ${b.date}. Status: ${b.status}. Total: $${b.total}.`,
    };
  }

  // Multiple matches
  const list = matches.map(b => `${b.code}: ${b.trip} on ${b.date} (${b.status})`).join('; ');
  return {
    found: true,
    multiple: true,
    count: matches.length,
    bookings: matches,
    message: `I found ${matches.length} bookings: ${list}. Which one are you looking for?`,
  };
}

async function cancelBooking({ booking_id, confirmation_code }) {
  // Find the booking first if we only have the code
  if (!booking_id && confirmation_code) {
    const lookup = await lookupBooking({ confirmation_code });
    if (!lookup.found) return { success: false, message: 'Could not find that booking to cancel.' };
    booking_id = lookup.booking_id;
  }

  if (!booking_id) {
    return { success: false, message: 'I need a booking to cancel. Please look up the booking first.' };
  }

  // Update booking status to cancelled
  const result = await cfRequest('PUT', `booking/${booking_id}`, `status_id=X`);

  if (result?.request?.status === 'OK' || result?.booking) {
    return {
      success: true,
      booking_id,
      message: `Your booking has been cancelled. If you'd like to rebook in the future, just give us a call anytime.`,
    };
  }

  return { success: false, message: 'I had trouble cancelling that booking. Let me transfer you to Captain Curt to help with that.', details: result?.request?.error };
}

async function checkAvailability({ trip_type, date, guests }) {
  const key = matchTrip(trip_type);
  if (!key) return { available: false, error: `Unknown trip type: ${trip_type}. Available: Lingcod & Rockfish, Offshore Rockfish, Halibut, Halibut & Lingcod Combo, Tuna, Crabbing.` };

  const item = ITEMS[key];
  const dateStr = formatDate(date);
  if (!dateStr) return { available: false, error: `Could not parse date: ${date}. Please use a format like March 1, 2026.` };

  const numGuests = parseInt(guests) || 1;
  const data = await cfRequest('GET', `item/${item.id}?start_date=${dateStr}&end_date=${dateStr}&param%5Bguest%5D=${numGuests}`);

  const rate = data?.item?.rate || data?.rate;
  if (!rate || rate.status !== 'AVAILABLE') {
    return {
      available: false,
      trip: item.name,
      date,
      guests: numGuests,
      message: `Sorry, ${item.name} is not available on ${date} for ${numGuests} guests.`,
    };
  }

  return {
    available: true,
    trip: item.name,
    trip_key: key,
    date,
    date_formatted: dateStr,
    guests: numGuests,
    spots_remaining: rate.available,
    price_per_person: item.price,
    total_price: parseFloat(rate.sub_total),
    slip: rate.slip,
    start_time: rate.start_time,
    end_time: rate.end_time,
    message: `${item.name} is available on ${date}! ${rate.available} spots open. $${item.price}/person, total $${rate.sub_total} for ${numGuests} guests. Departure: ${rate.start_time}.`,
    crabbing_addon_available: (key === 'lingcod' || key === 'offshore'),
  };
}

async function createBooking({ slip, customer_name, customer_email, customer_phone, note, add_crabbing, guests, trip_date }) {
  if (!slip || !customer_name) {
    return { success: false, error: 'Missing required fields: slip and customer_name.' };
  }

  // If adding crabbing, we need to get the crabbing slip too
  let slips = [slip];
  // The crabbing package is built into items 99316/99317 as package add-on
  // We handle it via the package opt-in on the slip

  // Create session with slip
  const sessionBody = `slip[]=${encodeURIComponent(slip)}`;
  const session = await cfRequest('POST', 'booking/session', sessionBody);

  if (session?.request?.status !== 'OK') {
    return { success: false, error: 'Failed to create booking session.', details: session?.request?.error };
  }

  const sessionId = session?.booking?.session?.id;
  if (!sessionId) {
    return { success: false, error: 'No session ID returned.' };
  }

  // If crabbing add-on requested, opt in to the package
  if (add_crabbing) {
    const alterBody = `session_id=${sessionId}&alter%5B1.1%5D=optin`;
    await cfRequest('POST', 'booking/session', alterBody);
  }

  // Create the booking with customer info
  const formParts = [
    `session_id=${sessionId}`,
    `form%5Bcustomer_name%5D=${encodeURIComponent(customer_name)}`,
  ];
  if (customer_email) formParts.push(`form%5Bcustomer_email%5D=${encodeURIComponent(customer_email)}`);
  if (customer_phone) formParts.push(`form%5Bcustomer_phone%5D=${encodeURIComponent(customer_phone)}`);
  if (note) formParts.push(`form%5Bnote%5D=${encodeURIComponent(note)}`);

  const createResult = await cfRequest('POST', 'booking/create', formParts.join('&'));

  if (createResult?.request?.status === 'OK' || createResult?.booking) {
    const booking = createResult.booking || {};
    // Checkfront returns the code in booking.id (e.g. "NKNF-200226")
    // and the numeric ID in booking.booking_id
    const confCode = booking.id || booking.code || booking.booking_id;
    const bookingId = booking.booking_id;
    const total = booking.total || booking.sub_total;
    
    // Fetch full booking details to get the code if not in create response
    let finalCode = confCode;
    if (!finalCode || finalCode == bookingId) {
      try {
        const details = await cfRequest('GET', `booking/${bookingId}`);
        finalCode = details?.booking?.id || confCode;
      } catch(e) {}
    }
    
    // Send confirmation
    if (customer_email) {
      sendConfirmationEmail(customer_email, customer_name, finalCode, total, note);
    }
    
    return {
      success: true,
      booking_id: bookingId,
      confirmation_code: finalCode,
      status: booking.status_name || 'Reserved',
      total: total,
      message: `Booking confirmed! Confirmation code: ${finalCode}. Total: $${total}.`,
    };
  }

  return { success: false, error: 'Failed to create booking.', details: createResult?.request?.error };
}

// --- Booking Confirmation (placeholder - Render blocks SMTP) ---
function sendConfirmationEmail(email, name, code, total, note) {
  console.log(`[CONFIRM] Booking ${code} for ${name} (${email}) - $${total}`);
}

// --- Vapi Webhook Server ---

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const msgType = payload.message?.type;

        // Handle tool-calls from Vapi
        if (msgType === 'tool-calls') {
          const toolCalls = payload.message?.toolCalls || payload.message?.tool_calls || [];
          const results = [];

          for (const call of toolCalls) {
            const fn = call.function?.name;
            const args = call.function?.arguments ? 
              (typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments) : {};

            let result;
            try {
              if (fn === 'check_availability') {
                result = await checkAvailability(args);
              } else if (fn === 'find_next_available') {
                result = await findNextAvailable(args);
              } else if (fn === 'lookup_booking') {
                result = await lookupBooking(args);
              } else if (fn === 'cancel_booking') {
                result = await cancelBooking(args);
              } else if (fn === 'create_booking') {
                result = await createBooking(args);
              } else {
                result = { error: `Unknown function: ${fn}` };
              }
            } catch (e) {
              result = { error: e.message };
            }

            results.push({
              toolCallId: call.id,
              result: JSON.stringify(result),
            });
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ results }));
          return;
        }

        // Log other message types
        console.log(`[${new Date().toISOString()}] ${msgType || 'unknown'}:`, JSON.stringify(payload).slice(0, 200));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));

      } catch (e) {
        console.error('Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Pacific Charter Services voice agent webhook running' }));
  }
});

server.listen(PORT, () => {
  console.log(`Pacific Charter webhook server running on port ${PORT}`);
});
