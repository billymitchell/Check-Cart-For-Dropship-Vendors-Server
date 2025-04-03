// Import required modules.
const express = require('express');        // For setting up the server and routes.
const path = require('path');              // For handling file paths.
require('dotenv').config();
const cors = require('cors');

// Instantiate the Express application.
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON request bodies.
app.use(express.json());

// Load and process the store lookup table statically.
const rawStoreLookup = require('./store-lookup-table.json');
const storeLookupTable = rawStoreLookup.map(store => {
  if (store.Subdomain) {
    return {
      ...store,
      "API Key": process.env[store.Subdomain] || `default-${store.Subdomain}`
    };
  }
  return store;
});

// Build the list of allowed origins based on the store lookup table.
const allowedOrigins = storeLookupTable.reduce((acc, store) => {
  if (store.Subdomain) {
    // Format subdomain to a full origin; adjust protocol if needed.
    acc.push(`https://${store.Subdomain}.mybrightsites.com`);
  }
  if (store["Custom URL"]) {
    acc.push(store["Custom URL"]);
  }
  return acc;
}, []);

console.log("Allowed origins:", allowedOrigins);

// Enable CORS with dynamic origin validation.
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'), false);
    }
  }
}));

// Define an array of vendor names that are considered dropship vendors.
const dropShipVendors = [
  'Cawley',
  'Visions',
  'Moslow',
  "Larlu",
  "LarLu",
  "Edwards Garment",
  "Cannon Hill",
  "Power Sales",
  "Winning Edge"
];

/**
 * Determines the subdomain from the provided hostname.
 *
 * The function checks for:
 * 1. A matching store in the lookup table that has a custom URL and a valid Subdomain.
 * 2. If the hostname ends with '.mybrightsites.com', extracts the subdomain.
 * 3. Otherwise, defaults to "centricity-test-store".
 *
 * @param {string} hostname - The hostname from the request.
 * @returns {string} The determined subdomain.
 */
function getSubdomainFromHost(hostname) {
  // Default subdomain if nothing matches.
  const defaultSubdomain = "centricity-test-store";

  // Check if a store with a matching custom URL and valid Subdomain exists.
  const matchedStore = storeLookupTable.find(store => store["Custom URL"] === hostname && store.Subdomain);
  if (matchedStore) {
    console.log(`Matched store found for hostname "${hostname}": using subdomain "${matchedStore.Subdomain}"`);
    return matchedStore.Subdomain;
  }
  
  // If hostname ends with '.mybrightsites.com', extract the subdomain.
  if (hostname.endsWith('.mybrightsites.com')) {
    const extractedSubdomain = hostname.split('.mybrightsites.com')[0];
    console.log(`Extracted subdomain "${extractedSubdomain}" from hostname "${hostname}"`);
    return extractedSubdomain;
  }
  
  // Log warning when defaulting.
  console.warn(`No matching store for hostname "${hostname}". Defaulting to "${defaultSubdomain}"`);
  return defaultSubdomain;
}

/**
 * Retrieves vendor credentials based on the request hostname.
 *
 * For localhost, returns default test credentials.
 * For other hostnames, determines the subdomain and fetches the API key from the store lookup table or environment.
 *
 * @param {object} req - The Express request object.
 * @returns {object} An object containing the subdomain and API key.
 */
function getVendorCredentials(req) {
  const hostHeader = req.hostname;
  if (hostHeader === "localhost") {
    console.log("Request received from localhost; using test credentials.");
    return {
      subdomain: "centricity-test-store",
      apiKey: process.env["centricity-test-store"] || "default-api-key"
    };
  } else {
    const subdomain = getSubdomainFromHost(hostHeader);
    const store = storeLookupTable.find(s => s.Subdomain === subdomain);
    const apiKey = store ? store["API Key"] : process.env[subdomain] || `default-${subdomain}`;
    console.log(`Determined credentials for hostname "${hostHeader}": subdomain = "${subdomain}", apiKey = "${apiKey}"`);
    return { subdomain, apiKey };
  }
}

/**
 * Performs the vendor API fetch.
 *
 * Constructs the API URL using the subdomain and provided item ID, then makes a GET request.
 * Logs the process, and handles errors if the fetch fails or the response is not okay.
 *
 * @param {string} itemId - The vendor product ID.
 * @param {string} subdomain - The subdomain for constructing the API URL.
 * @param {string} apiKey - The API key used for authentication.
 * @returns {Promise<object>} The fetch response.
 */
async function fetchVendorData(itemId, subdomain, apiKey) {
  // Build the API URL.
  const API_BASE_URL = `https://${subdomain}.mybrightsites.com`;
  const apiUrl = `${API_BASE_URL}/api/v2.6.1/products/${itemId}?token=${apiKey}`;
  console.log(`Fetching vendor data for item "${itemId}" from URL: ${apiUrl}`);

  try {
    // Make the GET request using native fetch.
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!response.ok) {
      console.error(`Vendor API returned status ${response.status} for item "${itemId}"`);
    } else {
      console.log(`Successfully fetched data for item "${itemId}"`);
    }
    return response;
  } catch (err) {
    console.error(`Error reaching vendor service at URL: ${apiUrl}`, err);
    throw new Error("Unable to reach vendor service.");
  }
}

/**
 * API route to check an order for dropship vendors.
 *
 * GET /api/check-order-dropship
 * Expects a JSON order object in the request body with a "line_items" array.
 * Processes each line_item to fetch vendor data concurrently.
 * Returns a JSON response with the vendor names and a flag indicating if any vendor is a dropship vendor.
 */
app.get('/api/check-order-dropship', async (req, res) => {
  console.log("Received request at /api/check-order-dropship");
  
  // Validate the order object.
  const order = req.body;
  if (!order || !Array.isArray(order.line_items) || order.line_items.length === 0) {
    console.error("Invalid order_object: missing or empty 'line_items'.");
    return res.status(400).json({ error: "Invalid order_object. Provide at least one line_item." });
  }
  
  console.log(`Processing order with ${order.line_items.length} line items from ${req.protocol}://${req.get('host')}`);

  // Retrieve vendor credentials using the request hostname.
  const { subdomain, apiKey } = getVendorCredentials(req);

  try {
    // Process each line item concurrently.
    const vendorNamesArrays = await Promise.all(order.line_items.map(async (lineItem) => {
      try {
        const response = await fetchVendorData(lineItem.origin_product_id, subdomain, apiKey);
        if (!response.ok) {
          console.warn(`Fetch failed for line item ${lineItem.origin_product_id} with status ${response.status}`);
          return []; // Return an empty array if fetch fails.
        }
        const vendorData = await response.json();
        if (!vendorData || !Array.isArray(vendorData.vendors) || vendorData.vendors.length === 0) {
          console.warn(`No vendor data returned for line item ${lineItem.origin_product_id}`);
          return [];
        }
        // Map vendor data to vendor names.
        return vendorData.vendors.map(vendor => vendor.name);
      } catch (err) {
        console.error(`Error processing line item ${lineItem.origin_product_id}:`, err);
        return [];
      }
    }));

    // Flatten the array of vendor names.
    const vendorNames = vendorNamesArrays.flat();
    // Check if any vendor is in the dropship vendors list.
    const orderContainsDropshipVendors = vendorNames.some(name => dropShipVendors.includes(name));

    console.log("Order processed successfully. Vendor names:", vendorNames);
    console.log("Contains dropship vendors?", orderContainsDropshipVendors);

    return res.status(200).json({ vendorNames, orderContainsDropshipVendors });
  } catch (error) {
    console.error('Server error while processing order:', error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// Start the server.
app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}. Access it at http://localhost:${PORT}`);
});