#!/usr/bin/env node

import * as translator from './src/translator.js';

// Test the gallery shortcode preservation
const content = `
<p>This is a test post with a gallery:</p>

[gallery type="circle" ids="648,652,647,649,653,654,655,650,651"]

<p>And some more content after the gallery.</p>
`;

const result = translator.getPostContent(content);
console.log('Processed content:');
console.log(result);