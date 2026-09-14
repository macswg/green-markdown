# Markdown Feature Showcase

This file shows the common Markdown features. Each section explains the syntax, then shows the result.

---

# Heading 1

Written as `# Heading 1`. The top-level title of a document.

## Heading 2

Written as `## Heading 2`. Major sections.

### Heading 3

Written as `### Heading 3`. Subsections.

#### Heading 4

Written as `#### Heading 4`. Smaller subsections.

##### Heading 5

Written as `##### Heading 5`. Rarely used.

###### Heading 6

Written as `###### Heading 6`. The smallest heading level.

---

## Paragraphs and Line Breaks

A paragraph is one or more lines of text. Separate paragraphs with a blank line.

This is a second paragraph. To force a line break without a new paragraph,
end a line with two spaces or a backslash.\
This line follows a hard line break.

## Text Emphasis

- **Bold** — `**Bold**` or `__Bold__`
- *Italic* — `*Italic*` or `_Italic_`
- ***Bold and italic*** — `***Bold and italic***`
- ~~Strikethrough~~ — `~~Strikethrough~~`
- `Inline code` — wrap in backticks

## Blockquotes

Start lines with `>`:

> This is a blockquote. Useful for quoting someone or calling out text.
>
> > Blockquotes can be nested with `>>`.

## Lists

### Unordered list

Use `-`, `*`, or `+`:

- Apples
- Bananas
  - Indent two spaces for a nested item
  - Another nested item
- Cherries

### Ordered list

Use numbers followed by a period:

1. First step
2. Second step
   1. Nested numbered step
   2. Another nested step
3. Third step

### Task list

Use `- [ ]` for unchecked and `- [x]` for checked:

- [x] Write the example file
- [ ] Review how it renders
- [ ] Tweak the styling

## Links

- Inline link: [Anthropic](https://www.anthropic.com) — `[text](url)`
- Link with title: [Hover me](https://example.com "A tooltip title") — `[text](url "title")`
- Autolink: <https://example.com> — wrap a URL in `< >`
- Reference link: [Markdown Guide][guide] — define `[guide]: url` elsewhere
- Link to a heading: [Jump to Tables](#tables)

[guide]: https://www.markdownguide.org

## Images

Written as `![alt text](url)`:

![Placeholder image](https://placehold.co/400x120/2e7d32/ffffff?text=Example+Image)

## Code

### Inline code

Use single backticks: run `npm install` to install dependencies.

### Code block (no language)

Indent with fences of three backticks:

```
plain text code block
no syntax highlighting
```

### Code block with syntax highlighting

Add a language name after the opening fence:

```javascript
function greet(name) {
  // Say hello
  return `Hello, ${name}!`;
}
```

```python
def fib(n: int) -> int:
    """Return the nth Fibonacci number."""
    return n if n < 2 else fib(n - 1) + fib(n - 2)
```

```bash
git status && git log --oneline -5
```

## Tables

Use pipes `|` and hyphens `-`. Colons set column alignment:

| Left aligned | Centered | Right aligned |
| :----------- | :------: | ------------: |
| Apples       |    3     |         $1.20 |
| Bananas      |    12    |         $0.50 |
| Cherries     |   200    |        $10.00 |

## Horizontal Rules

Three or more `---`, `***`, or `___` on their own line:

---

## Collapsible Sections

HTML `<details>` and `<summary>` create a section you can expand:

<details>
<summary>Click to expand</summary>

Hidden content goes here. It can contain **Markdown** too:

- Item one
- Item two

</details>

## Footnotes

Add a footnote marker like `[^1]`, then define it anywhere.[^1]

[^1]: This is the footnote text. It usually renders at the bottom of the page.

## Escaping Characters

Put a backslash before a symbol to show it literally: \*not italic\*, \# not a heading, \`not code\`.

## Inline HTML

Some renderers allow raw HTML, like <kbd>Ctrl</kbd> + <kbd>C</kbd> for keyboard keys, or <mark>highlighted text</mark>.
