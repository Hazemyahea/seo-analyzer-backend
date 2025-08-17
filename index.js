const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const urlParser = require('url');
const http = require('http'); // Import Node.js http module
const https = require('https'); // Import Node.js https module
require('dotenv').config(); // Re-added: Load environment variables from .env file

// Configure axios to use Node.js's native http/https agents
// This helps prevent 'File is not defined' errors by ensuring Axios uses
// Node.js's native networking capabilities directly.
axios.defaults.httpAgent = new http.Agent({ keepAlive: true });
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true });


const app = express();
app.use(cors()); // Allows any Origin

app.get('/analyze', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const parsedUrl = urlParser.parse(url);
    const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;

    const startTime = Date.now(); // Record start time for page load
    const page = await axios.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
      },
      timeout: 15000 // Increased timeout to 15 seconds for more robust scraping
    });
    const endTime = Date.now(); // Record end time
    const loadTime = endTime - startTime; // Calculate load time in milliseconds

    const $ = cheerio.load(page.data);

    // Basic SEO Elements
    const title = $('title').text() || 'No title';
    let metaDescription =
      $('meta[name="description"]').attr('content') ||
      $('meta[name="Description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="og:description"]').attr('content') ||
      'No description';
    const h1Tags = [];
    $('h1').each((i, el) => h1Tags.push($(el).text().trim()));

    // Image Alt Attributes
    let imagesWithAlt = 0;
    let imagesWithoutAlt = 0;
    const imageData = [];
    $('img').each((i, el) => {
      const src = $(el).attr('src');
      const alt = $(el).attr('alt');
      const hasAlt = alt !== undefined && alt !== null && alt.trim() !== '';
      if (hasAlt) imagesWithAlt++;
      else imagesWithoutAlt++;
      if (src) imageData.push({ src, alt: alt || '', hasAlt });
    });

    // Internal and External Links (Dofollow/Nofollow)
    const allLinks = [];
    const internalLinks = [];
    const externalDofollowLinks = [];
    const externalNofollowLinks = [];
    $('a').each((i, el) => {
      const href = $(el).attr('href');
      if (href) {
        try {
          const absoluteHref = urlParser.resolve(baseUrl, href);
          allLinks.push(absoluteHref); // Collect all links for broken link check
          const parsedHref = urlParser.parse(absoluteHref);
          const rel = $(el).attr('rel') || '';

          if (parsedHref.protocol === parsedUrl.protocol && parsedHref.host === parsedUrl.host) {
            internalLinks.push(absoluteHref);
          } else {
            if (rel.includes('nofollow') || rel.includes('ugc') || rel.includes('sponsored')) {
              externalNofollowLinks.push(absoluteHref);
            } else {
              externalDofollowLinks.push(absoluteHref);
            }
          }
        } catch (linkError) {
          console.warn(`Could not parse link href: ${href} - ${linkError.message}`);
        }
      }
    });

    // --- Broken Links Check (RESTORED) ---
    const brokenLinks = [];
    const uniqueLinksToCheck = [...new Set(allLinks)]; // Ensure unique links
    const linkCheckPromises = uniqueLinksToCheck.map(link => {
      return axios.get(link, { // Using GET request for better reliability
          timeout: 10000, // Increased timeout to 10 seconds for individual link checks
          maxContentLength: 2000, // Only download first 2KB for efficiency
          responseType: 'arraybuffer', // Get as arraybuffer to prevent full parsing
          maxRedirects: 5, // Allow up to 5 redirects
          headers: { // Add more headers to mimic a browser
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'en-US,en;q=0.5',
            'Connection': 'keep-alive',
          },
          validateStatus: function (status) {
              // Resolve for 2xx, 3xx, 4xx responses.
              // 5xx and network errors will be caught by the .catch() block.
              return status >= 200 && status < 500; 
          }
        })
        .then(response => {
          // If status is 4xx (Client Error), it's considered broken.
          if (response.status >= 400 && response.status < 500) {
            return { url: link, status: response.status, type: 'Client Error' };
          }
          // For 2xx or 3xx (redirects), it's a good link, so return null to exclude it.
          return null; 
        })
        .catch(error => {
          let statusDetail = 'Unreachable';
          let errorType = 'Network Issue'; // Default type for errors caught here

          if (axios.isAxiosError(error)) {
            if (error.response) {
                statusDetail = error.response.status;
                if (error.response.status >= 500) {
                  errorType = 'Server Error'; 
                } else if (error.response.status >= 400 && error.response.status < 500) {
                    errorType = 'Client Error'; 
                }
            } else if (error.request) {
              if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
                  statusDetail = 'Timeout';
                  errorType = 'Network Issue';
              } else if (error.code === 'ENOTFOUND') {
                  statusDetail = 'DNS Resolution Failed';
                  errorType = 'Network Issue';
              } else if (error.code === 'ECONNREFUSED') {
                  statusDetail = 'Connection Refused';
                  errorType = 'Network Issue';
              } else if (error.code === 'ERR_NETWORK') { 
                  statusDetail = 'Generic Network Error';
                  errorType = 'Network Issue';
              } else {
                  statusDetail = `Axios Request Error: ${error.code || error.message}`;
                  errorType = 'Network Issue';
              }
            } else {
              statusDetail = error.message || 'Axios Setup Error';
              errorType = 'Unknown Axios Error';
            }
          } else { // Non-Axios errors
            statusDetail = error.message || 'Unknown Error';
            errorType = 'Non-Axios Error';
          }
          return { url: link, status: statusDetail, type: errorType };
        });
    });

    const linkCheckResults = await Promise.allSettled(linkCheckPromises);
    linkCheckResults.forEach(result => {
      if (result.status === 'fulfilled' && result.value !== null) {
        brokenLinks.push(result.value);
      } else if (result.status === 'rejected') {
        brokenLinks.push(result.reason); 
      }
    });

    // --- Schema Markup Check ---
    const schemaData = [];
    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const schemaJson = JSON.parse($(el).html());
        if (Array.isArray(schemaJson)) {
            schemaJson.forEach(item => {
                if (item['@type']) schemaData.push(item['@type']);
            });
        } else if (schemaJson['@type']) {
            schemaData.push(schemaJson['@type']);
        }
      } catch (e) {
        console.warn('Could not parse JSON-LD schema:', e.message);
      }
    });

    // --- Keyword Suggestions using LLM (RESTORED) ---
    let keywordSuggestions = [];
    let mainContent = '';
    $('p, h1, h2, h3, h4, h5, h6, li, blockquote, article, main').each((i, el) => {
        mainContent += $(el).text() + '\n';
    });
    mainContent = mainContent.replace(/\s\s+/g, ' ').trim();

    const CONTENT_CHAR_LIMIT = 6000;
    const contentToSendToLLM = mainContent.substring(0, CONTENT_CHAR_LIMIT);

    if (contentToSendToLLM.length > 50) {
      const chatHistory = [];
      const prompt = `استخرج أهم الكلمات المفتاحية الرئيسية والفرعية من هذا النص. قم بتضمين كلمات مفتاحية طويلة الذيل (long-tail keywords). لا تقم بتضمين الكلمات المفتاحية الموجودة في سؤالك. قم بإرجاع قائمة بالكلمات المفتاحية فقط، كل كلمة مفتاحية في سطر جديد.
      المحتوى:
      ${contentToSendToLLM}
      `;

      chatHistory.push({ role: "user", parts: [{ text: prompt }] });
      const payload = { contents: chatHistory };
      
      const apiKey = process.env.GEMINI_API_KEY; // <---- Reading API Key from environment variable
      if (!apiKey) {
          console.error('GEMINI_API_KEY is not set in environment variables!');
          keywordSuggestions = ["AI analysis failed: Gemini API key is missing. Please set GEMINI_API_KEY environment variable."];
      } else {
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;

        try {
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await response.json();

            if (result.candidates && result.candidates.length > 0 &&
                result.candidates[0].content && result.candidates[0].content.parts &&
                result.candidates[0].content.parts.length > 0) {
                const rawKeywords = result.candidates[0].content.parts[0].text;
                keywordSuggestions = rawKeywords.split('\n').map(k => k.trim()).filter(k => k.length > 0);
            } else {
                console.warn('Gemini API did not return expected keyword suggestions. Response:', result);
            }
        } catch (llmError) {
            console.error('Error calling Gemini API for keyword suggestions:', llmError);
            keywordSuggestions = ["Failed to get keyword suggestions from AI. Check your API key and network connection."];
        }
      }
    } else {
        keywordSuggestions = ["Not enough textual content to generate keyword suggestions."];
    }
    // --- End Keyword Suggestions ---


    // Custom SEO Score Calculation
    let score = 50;
    const strengths = [];
    const issues = [];

    if (title.length > 0 && title.length <= 60) { score += 10; strengths.push('Title is present and suitable length ✅'); }
    else if (title.length > 60) issues.push('Title is too long (preferably less than 60 characters) ❌');
    else issues.push('No Title ❌');

    if (metaDescription !== 'No description') { score += 10; strengths.push('Meta description is present ✅'); }
    else issues.push('No Meta description ❌');
    if (metaDescription.length < 50 || metaDescription.length > 160) issues.push('Meta description is too short or too long ❌');

    if (h1Tags.length === 1) { score += 10; strengths.push('One H1 is good ✅'); }
    else if (h1Tags.length === 0) issues.push('No H1 ❌');
    else issues.push(`Number of H1 = ${h1Tags.length} (one is preferred) ❌`);

    if (imagesWithoutAlt === 0 && imageData.length > 0) { score += 10; strengths.push('All images have alt attributes ✅'); }
    else if (imagesWithoutAlt > 0) issues.push(`Missing alt attributes on ${imagesWithoutAlt} images ❌`);
    else strengths.push('No images found on the page.');

    if (internalLinks.length > 0) { score += 5; strengths.push(`Found ${internalLinks.length} internal links. Good for navigation. ✅`); }
    else issues.push('No internal links found on the page. ❌');

    if (externalDofollowLinks.length > 0) { score += 5; strengths.push(`Found ${externalDofollowLinks.length} dofollow external links. Good for linking to authority sites. ✅`); }
    
    // Penalize only confirmed broken links (4xx, 5xx)
    const confirmedBrokenLinksCount = brokenLinks.filter(link => link.type === 'Client Error' || link.type === 'Server Error').length;
    if (confirmedBrokenLinksCount > 0) { 
        issues.push(`Found ${confirmedBrokenLinksCount} broken links. Fix them! ❌`); 
        score -= (confirmedBrokenLinksCount * 5); // Increased penalty for actual broken links
    }
    // Warn for connection issues, but don't heavily penalize score
    const networkIssueLinksCount = brokenLinks.filter(link => link.type === 'Network Issue' || link.type === 'Connection Problem').length;
    if (networkIssueLinksCount > 0) {
        issues.push(`Found ${networkIssueLinksCount} links with connection problems or timeouts. Check network or server configuration. ⚠️`);
    }

    if (schemaData.length > 0) { strengths.push(`Found Schema Markup (${schemaData.join(', ')}) ✅`); score += 5; }
    else issues.push('No Schema Markup found. Consider adding it for rich results. ⚠️');

    if (score > 100) score = 100;
    if (score < 0) score = 0; // Ensure score doesn't go below 0

    const status = score >= 80 ? 'good' : score >= 60 ? 'average' : 'bad';

    res.json({
      url,
      title,
      metaDescription,
      performanceScore: score,
      status,
      strengths,
      issues,
      h1Tags,
      totalImages: imageData.length,
      imagesWithAlt,
      imagesWithoutAlt,
      imageData,
      loadTime,
      internalLinks,
      externalDofollowLinks,
      externalNofollowLinks,
      brokenLinks, // NEW: Re-added brokenLinks
      schemaData,
      keywordSuggestions, // NEW: Re-added keywordSuggestions
    });
  } catch (err) {
    console.error(err.message);
    let errorMessage = 'Failed to analyze website. Some websites block scraping or URL is invalid.';
    if (axios.isAxiosError(err) && err.code === 'ECONNABORTED') {
      errorMessage = 'Website took too long to respond or could not be reached.';
    } else if (axios.isAxiosError(err) && err.response && err.response.status === 404) {
      errorMessage = 'The URL returned a 404 Not Found error.';
    } else if (axios.isAxiosError(err) && err.response && err.response.status === 403) {
      errorMessage = 'Access to the URL was denied (403 Forbidden).';
    }
    res.status(500).json({ error: errorMessage });
  }
});

// Use the PORT environment variable provided by hosting platforms, or default to 3001
const PORT = process.env.PORT || 3001; 
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
