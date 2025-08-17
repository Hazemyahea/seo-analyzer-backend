// index.js
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const urlParser = require('url');

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
          allLinks.push(absoluteHref); // Collect all links
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
      schemaData,
      // Removed keywordSuggestions from here
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
