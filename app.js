// Import required modules from Node.js and third-party libraries.
const express = require('express'); // Framework for setting up the server and routes.
const path = require('path');       // Utility for handling and transforming file paths.
require('dotenv').config();         // Load environment variables from a .env file.
const fetch = require('node-fetch'); // Static require for node-fetch

// Instantiate the Express application.
const app = express();
// Set the port to an environment variable or use 3000 as the default.
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON request bodies.
app.use(express.json());

// Middleware to serve static files (e.g. your frontend assets)
app.use(express.static(path.join(__dirname, '../frontend')));

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

// Load and process the store lookup table statically.
// This automatically parses the JSON file and adds an "API Key" property where applicable.
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

/**
 * Determines the subdomain from the provided hostname.
 *
 * The function has a three-step logic:
 * 1. If a store in the lookup table has a matching "Custom URL" equal to the hostname and a valid Subdomain, return that Subdomain.
 * 2. If the hostname ends with '.mybrightsites.com', extract and return the main part (subdomain) before that segment.
 * 3. Otherwise, default to a preset subdomain ("centricity-test-store").
 *
 * @param {string} hostname - The hostname from the request.
 * @returns {string} The determined subdomain.
 */
function getSubdomainFromHost(hostname) {
  const defaultSubdomain = "centricity-test-store";

  // Check for a matching store with a custom URL and valid Subdomain.
  const matchedStore = storeLookupTable.find(store => store["Custom URL"] === hostname && store.Subdomain);
  if (matchedStore) {
    return matchedStore.Subdomain;
  }
  
  // If the hostname is in the expected mybrightsites format, extract the subdomain.
  if (hostname.endsWith('.mybrightsites.com')) {
    return hostname.split('.mybrightsites.com')[0];
  }
  
  return defaultSubdomain;
}

/**
 * Helper function to get vendor credentials based on the request hostname.
 *
 * @param {object} req - the Express request object.
 * @returns {object} An object containing both subdomain and API key.
 */
function getVendorCredentials(req) {
  const hostHeader = req.hostname;
  if (hostHeader === "localhost") {
    return {
      subdomain: "centricity-test-store",
      apiKey: process.env["centricity-test-store"] || "default-api-key"
    };
  } else {
    const subdomain = getSubdomainFromHost(hostHeader);
    const store = storeLookupTable.find(s => s.Subdomain === subdomain);
    const apiKey = store ? store["API Key"] : process.env[subdomain] || `default-${subdomain}`;
    return { subdomain, apiKey };
  }
}

/**
 * Helper function that performs the vendor API fetch.
 *
 * @param {string} itemId - The vendor product id.
 * @param {string} subdomain - The subdomain for constructing the API URL.
 * @param {string} apiKey - The API key used for authentication.
 * @returns {Promise<object>} The fetch response.
 */
async function fetchVendorData(itemId, subdomain, apiKey) {
  // Construct the API URL.
  const API_BASE_URL = `https://${subdomain}.mybrightsites.com`;
  const apiUrl = `${API_BASE_URL}/api/v2.6.1/products/${itemId}?token=${apiKey}`;

  // Make the GET request.
  let response;
  try {
    response = await fetch(apiUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    throw new Error("Unable to reach vendor service.");
  }
  return response;
}

/**
 * API route to fetch vendor data for a given order's line_items.
 * Endpoint: GET /api/check-order-dropship
 *
 * Expects a URL-encoded JSON order_object in the query parameters.
 * Processes each line_item (using line_item.id) to fetch vendor info.
 * Returns vendor names and a flag indicating if any vendor is a dropship vendor.
 */
app.get('/api/check-order-dropship', async (req, res) => {
  let order;
  try {
    order = JSON.parse(req.query.order_object);
  } catch (err) {
    return res.status(400).json({ error: "Invalid or missing order_object in query parameters." });
  }

  if (!order || !Array.isArray(order.line_items) || order.line_items.length === 0) {
    return res.status(400).json({ error: "Invalid order_object. Provide at least one line_item." });
  }

  console.log("Request from domain:", req.protocol + '://' + req.get('host'));

  // Retrieve vendor credentials based on the request hostname.
  const { subdomain, apiKey } = getVendorCredentials(req);

  try {
    // Process each line item concurrently.
    const vendorNamesArrays = await Promise.all(order.line_items.map(async (lineItem) => {
      try {
        const response = await fetchVendorData(lineItem.id, subdomain, apiKey);
        if (!response.ok) {
          // Skip on error for this line item.
          return [];
        }
        const vendorData = await response.json();
        if (!vendorData || !vendorData.vendors || vendorData.vendors.length === 0) {
          return [];
        }
        // Return all vendor names from this line item's data.
        return vendorData.vendors.map(vendor => vendor.name);
      } catch (err) {
        console.error(`Error processing line item ${lineItem.id}:`, err);
        return [];
      }
    }));

    // Flatten the resulting arrays into one single array.
    const vendorNames = vendorNamesArrays.flat();
    // Determine if any vendor name is on the dropship list.
    const orderContainsDropshipVendors = vendorNames.some(name => dropShipVendors.includes(name));

    // Return the results.
    return res.status(200).json({ vendorNames, orderContainsDropshipVendors });
    
  } catch (error) {
    console.error('Server error processing order:', error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// Start listening on the specified PORT and log the information to the console.
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}. Access it here: http://localhost:${PORT}`);
});