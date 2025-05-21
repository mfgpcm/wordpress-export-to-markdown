import chalk from 'chalk';
import fs from 'fs';
import * as luxon from 'luxon';
import * as data from './data.js';
import * as frontmatter from './frontmatter.js';
import * as shared from './shared.js';
import * as translator from './translator.js';

export async function parseFilePromise() {
	shared.logHeading('Parsing');
	const content = await fs.promises.readFile(shared.config.input, 'utf8');
	const rssData = await data.load(content);
	const allPostData = rssData.child('channel').children('item');

	const postTypes = getPostTypes(allPostData);
	const posts = collectPosts(allPostData, postTypes);

	const images = [];
	if (shared.config.saveImages === 'attached' || shared.config.saveImages === 'all') {
		images.push(...collectAttachedImages(allPostData));
	}
	if (shared.config.saveImages === 'scraped' || shared.config.saveImages === 'all') {
		images.push(...collectScrapedImages(allPostData, postTypes));
	}

	mergeImagesIntoPosts(images, posts);
	populateFrontmatter(posts);

	return posts;
}

function getPostTypes(allPostData) {
	// search export file for all post types minus some specific types we don't want
	const postTypes = [...new Set(allPostData // new Set() is used to dedupe array
		.map((postData) => postData.childValue('post_type'))
		.filter((postType) => ![
			'attachment',
			'revision',
			'nav_menu_item',
			'custom_css',
			'customize_changeset',
			'oembed_cache',
			'user_request',
			'wp_block',
			'wp_global_styles',
			'wp_navigation',
			'wp_template',
			'wp_template_part'
		].includes(postType))
	)];

	// change order to "post", "page", then all custom post types (alphabetically)
	prioritizePostType(postTypes, 'page');
	prioritizePostType(postTypes, 'post');

	return postTypes;
}

function getItemsOfType(allPostData, type) {
	return allPostData.filter((item) => item.childValue('post_type') === type);
}

function collectPosts(allPostData, postTypes) {
	let allPosts = [];
	postTypes.forEach((postType) => {
		const postsForType = getItemsOfType(allPostData, postType)
			.filter((postData) => postData.childValue('status') !== 'trash')
			.filter((postData) => !(postType === 'page' && postData.childValue('post_name') === 'sample-page'))
			.map((postData) => buildPost(postData));

		if (postsForType.length > 0) {
			if (postType === 'post') {
				console.log(`${postsForType.length} normal posts found.`);
			} else if (postType === 'page') {
				console.log(`${postsForType.length} pages found.`);
			} else {
				console.log(`${postsForType.length} custom "${postType}" posts found.`);
			}
		}

		allPosts.push(...postsForType);
	});

	return allPosts;
}

function buildPost(data) {
	return {
		// full raw post data
		data,

		// body content converted to markdown
		content: translator.getPostContent(data.childValue('encoded')),

		// particularly useful values for all sorts of things
		type: data.childValue('post_type'),
		id: data.childValue('post_id'),
		isDraft: data.childValue('status') === 'draft',
		slug: decodeURIComponent(data.childValue('post_name')),
		date: getPostDate(data),
		coverImageId: getPostMetaValue(data, '_thumbnail_id'),

		// these are possibly set later in mergeImagesIntoPosts()
		coverImage: undefined,
		coverImageDescription: undefined,
		imageUrls: [],
		
		// store image descriptions by filename
		imageDescriptions: {}
	};
}

function getPostDate(data) {
	const date = luxon.DateTime.fromRFC2822(data.childValue('pubDate'), { zone: shared.config.timezone });
	return date.isValid ? date : undefined;
}

function getPostMetaValue(data, key) {
	const metas = data.children('postmeta');
	const meta = metas.find((meta) => meta.childValue('meta_key') === key);
	return meta ? meta.childValue('meta_value') : undefined;
}

function collectAttachedImages(allPostData) {
	const images = getItemsOfType(allPostData, 'attachment')
		// filter to certain image file types
		.filter((attachment) => {
			const url = attachment.childValue('attachment_url');
			return url && (/\.(gif|jpe?g|png|webp)(\?|$)/i).test(url);
		})
		.map((attachment) => {
			// Extract image description from content:encoded, excerpt:encoded, or title
			let description = '';
			
			// Try to get description from content:encoded
			const contentEncoded = attachment.optionalChildValue('encoded');
			if (contentEncoded && contentEncoded.trim()) {
				description = contentEncoded.trim();
			}
			
			// If no description found, try excerpt:encoded
			if (!description) {
				const excerptEncoded = attachment.optionalChildValue('excerpt:encoded');
				if (excerptEncoded && excerptEncoded.trim()) {
					description = excerptEncoded.trim();
				}
			}
			
			// If still no description, try title
			if (!description) {
				const title = attachment.optionalChildValue('title');
				if (title && title.trim()) {
					description = title.trim();
				}
			}
			
			return {
				id: attachment.childValue('post_id'),
				postId: attachment.optionalChildValue('post_parent') ?? 'nope', // may not exist (cover image in a squarespace export, for example)
				url: attachment.childValue('attachment_url'),
				description: description
			};
		});

	console.log(images.length + ' attached images found.');
	return images;
}

function collectScrapedImages(allPostData, postTypes) {
	const images = [];
	postTypes.forEach((postType) => {
		getItemsOfType(allPostData, postType).forEach((postData) => {
			const postId = postData.childValue('post_id');
			
			const postContent = postData.childValue('encoded');
			// Extract img tags with src, alt, and title attributes
			const imgMatches = [...postContent.matchAll(/<img(?=\s)[^>]+?(?<=\s)src="(.+?)"[^>]*>/gi)];
			
			imgMatches.forEach((match) => {
				const imgTag = match[0];
				const scrapedUrl = match[1];
				
				// Extract alt and title attributes if they exist
				let description = '';
				
				// Try to get alt attribute
				const altMatch = imgTag.match(/alt="([^"]*)"/i);
				if (altMatch && altMatch[1] && altMatch[1].trim()) {
					description = altMatch[1].trim();
				}
				
				// If no alt, try to get title attribute
				if (!description) {
					const titleMatch = imgTag.match(/title="([^"]*)"/i);
					if (titleMatch && titleMatch[1] && titleMatch[1].trim()) {
						description = titleMatch[1].trim();
					}
				}
				
				let url;
				if (isAbsoluteUrl(scrapedUrl)) {
					url = scrapedUrl;
				} else {
					const postLink = postData.childValue('link');
					if (isAbsoluteUrl(postLink)) {
						url = new URL(scrapedUrl, postLink).href;
					} else {
						throw new Error(`Unable to determine absolute URL from scraped image URL '${scrapedUrl}' and post link URL '${postLink}'.`);
					}
				}

				images.push({
					id: 'nope', // scraped images don't have an id
					postId,
					url,
					description
				});
			});
		});
	});

	console.log(images.length + ' images scraped from post body content.');
	return images;
}

function mergeImagesIntoPosts(images, posts) {
	images.forEach((image) => {
		posts.forEach((post) => {
			let shouldAttach = false;

			// this image was uploaded as an attachment to this post
			if (image.postId === post.id) {
				shouldAttach = true;
			}

			// this image was set as the featured image for this post
			if (image.id === post.coverImageId) {
				shouldAttach = true;
				post.coverImage = shared.getFilenameFromUrl(image.url);
				
				// Store the description for the cover image
				if (image.description) {
					post.coverImageDescription = image.description;
				}
			}

			if (shouldAttach && !post.imageUrls.includes(image.url)) {
				post.imageUrls.push(image.url);
				
				// Store the description for this image
				if (image.description) {
					const filename = shared.getFilenameFromUrl(image.url);
					post.imageDescriptions[filename] = image.description;
				}
			}
		});
	});
}

function populateFrontmatter(posts) {
	posts.forEach((post) => {
		post.frontmatter = {};
		shared.config.frontmatterFields.forEach((field) => {
			const [key, alias] = field.split(':');

			let frontmatterGetter = frontmatter[key];
			if (!frontmatterGetter) {
				throw `Could not find a frontmatter getter named "${key}".`;
			}

			post.frontmatter[alias ?? key] = frontmatterGetter(post);
		});
	});
}

function prioritizePostType(postTypes, postType) {
	const index = postTypes.indexOf(postType);
	if (index !== -1) {
		postTypes.splice(index, 1);
		postTypes.unshift(postType);
	}
}

function isAbsoluteUrl(url) {
	return (/^https?:\/\//i).test(url);
}
