import {
  processLatexTags,
  sanitizeUnsupportedMathBlocks,
} from '@/utils/latex-processing'
import { describe, expect, it } from 'vitest'

describe('latex-processing', () => {
  describe('processLatexTags', () => {
    it.each([
      [
        '109: display bracket math',
        'Here is an equation: \\[x^2 + y^2 = z^2\\]',
        'Here is an equation: \n\n$$\nx^2 + y^2 = z^2\n$$\n\n',
      ],
      [
        '118: multiple display blocks',
        '\\[a = b\\] and \\[c = d\\]',
        '\n\n$$\na = b\n$$\n\n and \n\n$$\nc = d\n$$\n\n',
      ],
      [
        '126: inline parentheses',
        'The value \\(x\\) is positive',
        'The value $$x$$ is positive',
      ],
      [
        '132: multiple inline expressions',
        'Given \\(a\\) and \\(b\\), find \\(c\\)',
        'Given $$a$$ and $$b$$, find $$c$$',
      ],
      ['140: backtick fence', '```\n\\[x\\]\n```', '```\n\\[x\\]\n```'],
      ['146: tilde fence', '~~~\n\\[x\\]\n~~~', '~~~\n\\[x\\]\n~~~'],
      ['152: inline code', 'Use `\\[x\\]` for math', 'Use `\\[x\\]` for math'],
      [
        '158: math outside protected code',
        '\\[a\\] then ```\\[b\\]``` then \\[c\\]',
        '\n\n$$\na\n$$\n\n then ```\\[b\\]``` then \n\n$$\nc\n$$\n\n',
      ],

      // --- The core bug fix: $\$AMOUNT$ patterns ---
      [
        '169: escaped dollar',
        'invested $\\$10,000$ in stocks',
        'invested $$\\$10,000$$ in stocks',
      ],
      [
        '175: multiple escaped amounts',
        '$\\$10,000$ invested would have grown to approximately $\\$35,000$ today.',
        '$$\\$10,000$$ invested would have grown to approximately $$\\$35,000$$ today.',
      ],
      [
        '184: decimal amount',
        'The price is $\\$19.99$ per unit',
        'The price is $$\\$19.99$$ per unit',
      ],
      [
        '190: comma and decimal amount',
        'Revenue reached $\\$1,234,567.89$',
        'Revenue reached $$\\$1,234,567.89$$',
      ],

      // --- Standard LaTeX math in single-dollar delimiters ---
      [
        '207: fraction',
        'The ratio is $\\frac{a}{b}$ exactly',
        'The ratio is $$\\frac{a}{b}$$ exactly',
      ],
      ['213: square root', 'Compute $\\sqrt{x}$', 'Compute $$\\sqrt{x}$$'],
      [
        '219: Greek commands',
        'where $\\alpha + \\beta$ equals 1',
        'where $$\\alpha + \\beta$$ equals 1',
      ],
      [
        '225: text macro',
        'the value $\\text{max}$ is used',
        'the value $$\\text{max}$$ is used',
      ],
      [
        '231: sum',
        'The sum $\\sum_{i=1}^{n} x_i$ converges',
        'The sum $$\\sum_{i=1}^{n} x_i$$ converges',
      ],
      [
        '237: integral',
        'Evaluate $\\int_0^1 f(x) dx$',
        'Evaluate $$\\int_0^1 f(x) dx$$',
      ],
      [
        '243: math font',
        'over the reals $\\mathbb{R}$',
        'over the reals $$\\mathbb{R}$$',
      ],
      [
        '249: limit',
        'as $\\lim_{n \\to \\infty} a_n$ approaches 0',
        'as $$\\lim_{n \\to \\infty} a_n$$ approaches 0',
      ],

      // --- Currency dollar signs that should NOT be converted ---
      [
        '257: unclosed comma amount',
        'The cost is $10,000 for the project',
        'The cost is $10,000 for the project',
      ],
      [
        '263: unclosed amount',
        'It costs $100 per month',
        'It costs $100 per month',
      ],
      [
        '269: multiple currency openings',
        'Prices range from $10 to $50, with premium at $100 each',
        'Prices range from $10 to $50, with premium at $100 each',
      ],
      ['275: currency range', 'between $10 and $15', 'between $10 and $15'],
      [
        '281: per-share currency',
        'the stock went from $10 to $20 per share',
        'the stock went from $10 to $20 per share',
      ],
      [
        '287: deposits',
        'We accept $500 and $1,000 deposits',
        'We accept $500 and $1,000 deposits',
      ],
      [
        '293: paired numeric math',
        'The value $10$ is small',
        'The value $$10$$ is small',
      ],
      [
        '299: paired comma number',
        'approximately $5,000$ people attended',
        'approximately $$5,000$$ people attended',
      ],
      [
        '305: single-character math',
        'the variable $x$ is used',
        'the variable $$x$$ is used',
      ],
      [
        '311: alphabetic math',
        'the string $abc$ is interesting',
        'the string $$abc$$ is interesting',
      ],
      [
        '317: operators without commands',
        'the equation $x^2 + y^2$ is familiar',
        'the equation $$x^2 + y^2$$ is familiar',
      ],

      // --- Dollar signs at sentence boundaries ---
      ['325: isolated trailing dollar', 'This costs 500$', 'This costs 500$'],
      [
        '331: space after dollar',
        'We spent $ 100 on supplies',
        'We spent $ 100 on supplies',
      ],

      // --- Interaction with existing $$ blocks ---
      [
        '339: existing display block',
        'Display math: $$x^2 + y^2 = z^2$$',
        'Display math: $$x^2 + y^2 = z^2$$',
      ],
      [
        '345: converted display and inline',
        'inline \\(x^2\\) and display \\[y^2\\]',
        'inline $$x^2$$ and display \n\n$$\ny^2\n$$\n\n',
      ],
      [
        '352: adjacent display and amount',
        '$$E = mc^2$$ and the cost is $\\$500$',
        '$$E = mc^2$$ and the cost is $$\\$500$$',
      ],
      [
        '359: adjacent converted inline and amount',
        '\\(E = mc^2\\) and the cost is $\\$500$',
        '$$E = mc^2$$ and the cost is $$\\$500$$',
      ],

      // --- Code block preservation with single-dollar ---
      [
        '368: escaped amount in inline code',
        'Use `$\\$10$` for dollar amounts',
        'Use `$\\$10$` for dollar amounts',
      ],
      [
        '374: escaped amount in fence',
        '```\n$\\$10,000$\n```',
        '```\n$\\$10,000$\n```',
      ],
      [
        '380: escaped amount inside and outside code',
        'Cost is $\\$100$ and code: `$\\$200$`',
        'Cost is $$\\$100$$ and code: `$\\$200$`',
      ],

      // --- Escaped dollar signs ---
      [
        '388: escaped opener with a plausible closer',
        'The price is \\$100/$end',
        'The price is \\$100/$end',
      ],

      // --- Multiple LaTeX expressions in same paragraph ---
      [
        '396: inline formula and suffixed amount',
        'The formula \\(E = mc^2\\) shows that $\\$1M$ is needed',
        'The formula $$E = mc^2$$ shows that $$\\$1M$$ is needed',
      ],
      [
        '403: three escaped amounts',
        'From $\\$100$ to $\\$200$ is a $\\$100$ increase',
        'From $$\\$100$$ to $$\\$200$$ is a $$\\$100$$ increase',
      ],

      // --- Edge cases for the closing delimiter ---
      ['413: whitespace before closer', '$\\$100 $ extra', '$\\$100 $ extra'],
      ['420: whitespace after opener', '$ \\$100$ extra', '$ \\$100$ extra'],

      // --- Real-world model outputs ---
      [
        '428: three amounts with punctuation',
        'The stock dropped from $\\$150$ to $\\$120$, a loss of $\\$30$ per share.',
        'The stock dropped from $$\\$150$$ to $$\\$120$$, a loss of $$\\$30$$ per share.',
      ],
      [
        '437: currency followed by math',
        'Revenue was $500M last year. The formula is $\\frac{revenue}{shares}$.',
        'Revenue was $500M last year. The formula is $$\\frac{revenue}{shares}$$.',
      ],
      [
        '447: escaped currency inside converted inline',
        'Given \\(P = \\$10,000\\) and a rate of \\(r = 0.05\\), the future value is $\\$12,500$.',
        'Given $$P = \\$10,000$$ and a rate of $$r = 0.05$$, the future value is $$\\$12,500$$.',
      ],
      [
        '456: multiplication',
        'the result is $3 \\times 4$',
        'the result is $$3 \\times 4$$',
      ],
      [
        '462: approximation',
        'roughly $\\approx 42$',
        'roughly $$\\approx 42$$',
      ],
      [
        '468: plus minus',
        'the value is $10 \\pm 2$',
        'the value is $$10 \\pm 2$$',
      ],
      [
        '474: comparisons',
        'when $x \\le 10$ and $y \\ge 5$',
        'when $$x \\le 10$$ and $$y \\ge 5$$',
      ],
      [
        '480: zero amount',
        'starting from $\\$0$ to $\\$1M$',
        'starting from $$\\$0$$ to $$\\$1M$$',
      ],
      [
        '486: suffixed amount',
        'raised $\\$50M$ in funding',
        'raised $$\\$50M$$ in funding',
      ],
      [
        '492: negative amount',
        'lost $\\$-500$ on the trade',
        'lost $$\\$-500$$ on the trade',
      ],

      // --- Dollar signs inside markdown link URLs ---
      [
        '500: currency with nonnumeric URL closer',
        'cost $100[link](https://example.com/$path) end',
        'cost $100[link](https://example.com/$path) end',
      ],
      [
        '507: dollars across multiple URLs',
        '**$10M+ ARR and a nine-figure valuation**[6](#cite-6~https://example.com/sell-stock/~Title)[4](#cite-4~https://example.com/$guide~Guide). If the valuation is north of $80–100M, most firms will accommodate.',
        '**$10M+ ARR and a nine-figure valuation**[6](#cite-6~https://example.com/sell-stock/~Title)[4](#cite-4~https://example.com/$guide~Guide). If the valuation is north of $80–100M, most firms will accommodate.',
      ],
      [
        '514: link text math and paired URL dollars',
        'See [$x > 0$](https://example.com/$path$) for details',
        'See [$$x > 0$$](https://example.com/$path$) for details',
      ],
      [
        '522: currency and URL closer',
        'raised $50M in funding[1](#cite~https://example.com/raises-$tail~Title) last year',
        'raised $50M in funding[1](#cite~https://example.com/raises-$tail~Title) last year',
      ],
      [
        '529: encoded URL text',
        'costs $100 per unit[3](#cite~https://example.com/~Product%20costs%20$amount%20per%20unit) in bulk',
        'costs $100 per unit[3](#cite~https://example.com/~Product%20costs%20$amount%20per%20unit) in bulk',
      ],
      [
        '536: multiple protected citation destinations',
        'The price is $500 and $1,000[1](#cite~url/$left$)[2](#cite~url/$right$). End.',
        'The price is $500 and $1,000[1](#cite~url/$left$)[2](#cite~url/$right$). End.',
      ],
      [
        '543: valid math beside citation',
        'Cost is $\\$100$ per unit[1](#cite~https://example.com/price).',
        'Cost is $$\\$100$$ per unit[1](#cite~https://example.com/price).',
      ],

      // --- Currency $ followed by digits should not be treated as closers ---
      [
        '553: currency separated by prose',
        'Before you celebrate the $2M, model the after-tax outcome. If your shares qualify for **QSBS** (federal 0% up to $10M gain), that $2M might be entirely tax-free. If QSBS has expired, you need to gross ~$3M+ in sale value to net $2M.',
        'Before you celebrate the $2M, model the after-tax outcome. If your shares qualify for **QSBS** (federal 0% up to $10M gain), that $2M might be entirely tax-free. If QSBS has expired, you need to gross ~$3M+ in sale value to net $2M.',
      ],
      [
        '560: currency across citation',
        "that $2M might be entirely tax-free[1](#cite-1~https://keystonegp.com/calculator/~Secondary%20Sale%20Calculator). If QSBS has expired or doesn't apply, you're looking at ~30–37% effective tax (federal + state), meaning you need to gross ~$3M+ in sale value to net $2M.",
        "that $2M might be entirely tax-free[1](#cite-1~https://keystonegp.com/calculator/~Secondary%20Sale%20Calculator). If QSBS has expired or doesn't apply, you're looking at ~30–37% effective tax (federal + state), meaning you need to gross ~$3M+ in sale value to net $2M.",
      ],
      [
        '567: digit-followed closer',
        'between $5 and $15 dollars',
        'between $5 and $15 dollars',
      ],
      [
        '573: tilde-prefixed currency closer',
        'that $2M might be tax-free, you need to gross ~$3M+ to net $2M.',
        'that $2M might be tax-free, you need to gross ~$3M+ to net $2M.',
      ],
      [
        '580: tight currency range',
        'costs $10-$20 per item',
        'costs $10-$20 per item',
      ],
      [
        '586: tight currency ratio',
        'the ratio is $100/$200 per unit',
        'the ratio is $100/$200 per unit',
      ],
      [
        '592: math despite nearby currency',
        'The cost is $500 per unit and the formula is $\\frac{a}{b}$ exactly.',
        'The cost is $500 per unit and the formula is $$\\frac{a}{b}$$ exactly.',
      ],
      [
        '600: paired dollars after nested URL parentheses',
        'See $x$[1](#cite~https://example.com/path_(section)/$tail$) for info',
        'See $$x$$[1](#cite~https://example.com/path_(section)/$tail$) for info',
      ],
      ['610: empty string', '', ''],
      ['614: plain text', 'Just plain text', 'Just plain text'],
      [
        '619: unclosed display math',
        'Start \\[x but no close',
        'Start \\[x but no close',
      ],
      ['626: terminal dollar', 'costs $', 'costs $'],
      ['632: triple dollars', 'text $$$ more text', 'text $$$ more text'],
      [
        '640: shortest escaped dollar expression',
        'the value $\\$$',
        'the value $$\\$$$',
      ],
      [
        '646: newline-adjacent expression',
        'cost is\n$\\$100$\nper unit',
        'cost is\n$$\\$100$$\nper unit',
      ],
    ])('%s', (_name, input, expected) => {
      expect(processLatexTags(input)).toBe(expected)
    })
  })

  describe('sanitizeUnsupportedMathBlocks', () => {
    it.each([
      ['655: remove label', '$$x^2 \\label{eq:1}$$', '$$x^2 $$'],
      ['661: replace omicron', '$$\\omicron$$', '$$o$$'],
      ['667: unwrap circled content', '$$\\circled{1}$$', '$$1$$'],
      ['673: replace mathscr', '$$\\mathscr{L}$$', '$$\\mathcal{L}$$'],
      [
        '679: preserve fenced command',
        '```\n$$\\label{x}$$\n```',
        '```\n$$\\label{x}$$\n```',
      ],
      [
        '685: replace in multiple math blocks',
        '$$\\omicron_1$$ text $$\\omicron_2$$',
        '$$o_1$$ text $$o_2$$',
      ],
    ])('%s', (_name, input, expected) => {
      expect(sanitizeUnsupportedMathBlocks(input)).toBe(expected)
    })
  })
})
