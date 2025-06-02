#!/usr/bin/env node

import * as translator from './src/translator.js';

// Test the gallery shortcode preservation for galleries without explicit IDs
const content = `
<p>This is a test post with a gallery without IDs:</p>

[gallery type="circle"]

<p>And some more content after the gallery.</p>
`;

const result = translator.getPostContent(content);
console.log('Processed content:');
console.log(result);