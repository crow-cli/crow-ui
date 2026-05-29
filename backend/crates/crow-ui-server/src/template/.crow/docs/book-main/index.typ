#import "/shared.typ": *

#set document(title: "Project Handbook")

#html.elem("style")[#google-fonts #book-css]

#html.elem("div", attrs: (class: "container"))[
  #html.elem("nav", attrs: (class: "toc"))[
    #html.elem("h2")[Contents]
    #html.elem("ul")[
      #toc-item([Getting Started with Typst], "./chapters/01_intro.html")
    ]
  ]

  #html.elem("main", attrs: (class: "content"))[
    #chapter-nav()

    #html.elem("h1")[Project Handbook]
    #html.elem("p")[Welcome to your project's documentation space. This is a living document — edit these files, add chapters, and compile to beautiful HTML.]

    #html.elem("h2")[Chapters]
    #html.elem("ul", attrs: (class: "book-list"))[
      #html.elem("li")[
        #html.elem("a", attrs: (href: "./chapters/01_intro.html"))[1. Getting Started with Typst]
        #html.elem("p", attrs: (class: "desc"))[Learn the basics of Typst markup and how to write beautiful documents.]
      ]
    ]
  ]
]
