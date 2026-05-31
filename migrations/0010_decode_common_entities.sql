UPDATE feeds
SET
  title = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(title, '&amp;amp;', '&amp;'), '&amp;#8217;', '&#8217;'), '&amp;#x2019;', '&#x2019;'), '&amp;rsquo;', '&rsquo;'), '&amp;quot;', '&quot;'), '&amp;apos;', '&apos;'), '&amp;nbsp;', '&nbsp;'), '&amp;ndash;', '&ndash;'), '&amp;mdash;', '&mdash;'), '&amp;ldquo;', '&ldquo;'), '&amp;rdquo;', '&rdquo;'), '&amp;hellip;', '&hellip;'),
  description = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(description, '&amp;amp;', '&amp;'), '&amp;#8217;', '&#8217;'), '&amp;#x2019;', '&#x2019;'), '&amp;rsquo;', '&rsquo;'), '&amp;quot;', '&quot;'), '&amp;apos;', '&apos;'), '&amp;nbsp;', '&nbsp;'), '&amp;ndash;', '&ndash;'), '&amp;mdash;', '&mdash;'), '&amp;ldquo;', '&ldquo;'), '&amp;rdquo;', '&rdquo;'), '&amp;hellip;', '&hellip;')
WHERE title LIKE '%&%' OR description LIKE '%&%';

UPDATE feed_items
SET
  title = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(title, '&amp;amp;', '&amp;'), '&amp;#8217;', '&#8217;'), '&amp;#x2019;', '&#x2019;'), '&amp;rsquo;', '&rsquo;'), '&amp;quot;', '&quot;'), '&amp;apos;', '&apos;'), '&amp;nbsp;', '&nbsp;'), '&amp;ndash;', '&ndash;'), '&amp;mdash;', '&mdash;'), '&amp;ldquo;', '&ldquo;'), '&amp;rdquo;', '&rdquo;'), '&amp;hellip;', '&hellip;'),
  author = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(author, '&amp;amp;', '&amp;'), '&amp;#8217;', '&#8217;'), '&amp;#x2019;', '&#x2019;'), '&amp;rsquo;', '&rsquo;'), '&amp;quot;', '&quot;'), '&amp;apos;', '&apos;'), '&amp;nbsp;', '&nbsp;'), '&amp;ndash;', '&ndash;'), '&amp;mdash;', '&mdash;'), '&amp;ldquo;', '&ldquo;'), '&amp;rdquo;', '&rdquo;'), '&amp;hellip;', '&hellip;'),
  summary = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(summary, '&amp;amp;', '&amp;'), '&amp;#8217;', '&#8217;'), '&amp;#x2019;', '&#x2019;'), '&amp;rsquo;', '&rsquo;'), '&amp;quot;', '&quot;'), '&amp;apos;', '&apos;'), '&amp;nbsp;', '&nbsp;'), '&amp;ndash;', '&ndash;'), '&amp;mdash;', '&mdash;'), '&amp;ldquo;', '&ldquo;'), '&amp;rdquo;', '&rdquo;'), '&amp;hellip;', '&hellip;')
WHERE title LIKE '%&%' OR author LIKE '%&%' OR summary LIKE '%&%';

UPDATE bookmarks
SET
  title = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(title, '&amp;amp;', '&amp;'), '&amp;#8217;', '&#8217;'), '&amp;#x2019;', '&#x2019;'), '&amp;rsquo;', '&rsquo;'), '&amp;quot;', '&quot;'), '&amp;apos;', '&apos;'), '&amp;nbsp;', '&nbsp;'), '&amp;ndash;', '&ndash;'), '&amp;mdash;', '&mdash;'), '&amp;ldquo;', '&ldquo;'), '&amp;rdquo;', '&rdquo;'), '&amp;hellip;', '&hellip;'),
  description = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(description, '&amp;amp;', '&amp;'), '&amp;#8217;', '&#8217;'), '&amp;#x2019;', '&#x2019;'), '&amp;rsquo;', '&rsquo;'), '&amp;quot;', '&quot;'), '&amp;apos;', '&apos;'), '&amp;nbsp;', '&nbsp;'), '&amp;ndash;', '&ndash;'), '&amp;mdash;', '&mdash;'), '&amp;ldquo;', '&ldquo;'), '&amp;rdquo;', '&rdquo;'), '&amp;hellip;', '&hellip;')
WHERE (source = 'rss_item' OR source_feed_item_id IS NOT NULL) AND (title LIKE '%&%' OR description LIKE '%&%');

UPDATE feeds
SET
  title = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(title, '&#8217;', char(8217)), '&#x2019;', char(8217)), '&rsquo;', char(8217)), '&apos;', char(39)), '&#39;', char(39)), '&quot;', char(34)), '&nbsp;', ' '), '&ndash;', char(8211)), '&mdash;', char(8212)), '&ldquo;', char(8220)), '&rdquo;', char(8221)), '&hellip;', char(8230)),
  description = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(description, '&#8217;', char(8217)), '&#x2019;', char(8217)), '&rsquo;', char(8217)), '&apos;', char(39)), '&#39;', char(39)), '&quot;', char(34)), '&nbsp;', ' '), '&ndash;', char(8211)), '&mdash;', char(8212)), '&ldquo;', char(8220)), '&rdquo;', char(8221)), '&hellip;', char(8230))
WHERE title LIKE '%&%' OR description LIKE '%&%';

UPDATE feed_items
SET
  title = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(title, '&#8217;', char(8217)), '&#x2019;', char(8217)), '&rsquo;', char(8217)), '&apos;', char(39)), '&#39;', char(39)), '&quot;', char(34)), '&nbsp;', ' '), '&ndash;', char(8211)), '&mdash;', char(8212)), '&ldquo;', char(8220)), '&rdquo;', char(8221)), '&hellip;', char(8230)),
  author = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(author, '&#8217;', char(8217)), '&#x2019;', char(8217)), '&rsquo;', char(8217)), '&apos;', char(39)), '&#39;', char(39)), '&quot;', char(34)), '&nbsp;', ' '), '&ndash;', char(8211)), '&mdash;', char(8212)), '&ldquo;', char(8220)), '&rdquo;', char(8221)), '&hellip;', char(8230)),
  summary = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(summary, '&#8217;', char(8217)), '&#x2019;', char(8217)), '&rsquo;', char(8217)), '&apos;', char(39)), '&#39;', char(39)), '&quot;', char(34)), '&nbsp;', ' '), '&ndash;', char(8211)), '&mdash;', char(8212)), '&ldquo;', char(8220)), '&rdquo;', char(8221)), '&hellip;', char(8230))
WHERE title LIKE '%&%' OR author LIKE '%&%' OR summary LIKE '%&%';

UPDATE bookmarks
SET
  title = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(title, '&#8217;', char(8217)), '&#x2019;', char(8217)), '&rsquo;', char(8217)), '&apos;', char(39)), '&#39;', char(39)), '&quot;', char(34)), '&nbsp;', ' '), '&ndash;', char(8211)), '&mdash;', char(8212)), '&ldquo;', char(8220)), '&rdquo;', char(8221)), '&hellip;', char(8230)),
  description = replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(description, '&#8217;', char(8217)), '&#x2019;', char(8217)), '&rsquo;', char(8217)), '&apos;', char(39)), '&#39;', char(39)), '&quot;', char(34)), '&nbsp;', ' '), '&ndash;', char(8211)), '&mdash;', char(8212)), '&ldquo;', char(8220)), '&rdquo;', char(8221)), '&hellip;', char(8230))
WHERE (source = 'rss_item' OR source_feed_item_id IS NOT NULL) AND (title LIKE '%&%' OR description LIKE '%&%');

UPDATE feeds
SET
  title = replace(replace(replace(title, '&amp;', '&'), '&lt;', '<'), '&gt;', '>'),
  description = replace(replace(replace(description, '&amp;', '&'), '&lt;', '<'), '&gt;', '>')
WHERE title LIKE '%&%' OR description LIKE '%&%';

UPDATE feed_items
SET
  title = replace(replace(replace(title, '&amp;', '&'), '&lt;', '<'), '&gt;', '>'),
  author = replace(replace(replace(author, '&amp;', '&'), '&lt;', '<'), '&gt;', '>'),
  summary = replace(replace(replace(summary, '&amp;', '&'), '&lt;', '<'), '&gt;', '>')
WHERE title LIKE '%&%' OR author LIKE '%&%' OR summary LIKE '%&%';

UPDATE bookmarks
SET
  title = replace(replace(replace(title, '&amp;', '&'), '&lt;', '<'), '&gt;', '>'),
  description = replace(replace(replace(description, '&amp;', '&'), '&lt;', '<'), '&gt;', '>')
WHERE (source = 'rss_item' OR source_feed_item_id IS NOT NULL) AND (title LIKE '%&%' OR description LIKE '%&%');
