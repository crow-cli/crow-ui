#import "/shared.typ": *

#set document(title: "Getting Started with Typst")

#html.elem("style")[#google-fonts #book-css]

#html.elem("div", attrs: (class: "container"))[
  #html.elem("nav", attrs: (class: "toc"))[
    #html.elem("h2")[Contents]
    #html.elem("ul")[
      #toc-item([Getting Started with Typst], "./01_intro.html", active: true)
    ]
  ]

  #html.elem("main", attrs: (class: "content"))[
    #chapter-nav()

    = Getting Started with Typst

    Typst is a markup-based typesetting system. You write content in plain text with lightweight syntax, and Typst produces beautiful PDFs and HTML pages.

    == Headings

    Use equals signs for headings. More equals means deeper nesting:

    ```typst
    = Top Level Heading
    == Section Heading
    === Subsection Heading
    ```

    == Paragraphs and Text

    Just write. Blank lines separate paragraphs.

    Make text *italic* with asterisks, **bold** with double asterisks, and `monospace` with backticks.

    == Lists

    Unordered lists use dashes or plus signs:

    ```typst
    - First item
    - Second item
    - Nested item
    ```

    Ordered lists use numbers:

    ```typst
    + Step one
    + Step two
    + Step three
    ```

    == Code Blocks

    Fence code with triple backticks:

    ```typst
    #let greeting = "Hello, world!"
    #greeting
    ```

    == Math

    Inline math: $x^2 + y^2 = z^2$

    Display math:

    $ sum_(i=0)^n i = frac(n(n+1), 2) $

    == Links

    ```typst
    Visit #link("https://typst.app")[the Typst website].
    ```

    == Custom Functions

    Define reusable functions with `#let`:

    ```typst
    #let note(body) = {
      block(
        fill: rgb("#fef3c7"),
        inset: 1em,
        radius: 6pt,
        body
      )
    }

    #note[
      This is a custom note block!
    ]
    ```

    == HTML Output

    Crow Docs compiles your Typst files to HTML using:

    ```bash
    typst compile --root . --features html -f html file.typ
    ```

    The preview panel in crow-ui automatically recompiles when you save.

    == Next Steps

    - Edit this file to replace this tutorial with your own content
    - Add new chapters by creating files in `chapters/`
    - Customize styles in `shared.typ`
    - Write journal entries in `journal/YYYY/MM/DD.typ`

    Happy writing.
  ]
]
