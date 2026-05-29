#import "shared.typ": *

#set document(title: "Crow Documentation Library")

#html.elem("style")[#google-fonts #book-css]

#html.elem("div", attrs: (class: "container"))[
  #html.elem("main", attrs: (class: "content"))[
    #html.elem("div", attrs: (class: "hero"))[
      #html.elem("h1")[Documentation Library]
      #html.elem("p", attrs: (class: "subtitle"))[A living collection of books, notes, and journals — written in Typst, published to the web.]
    ]

    #html.elem("h2")[Books]
    #html.elem("ul", attrs: (class: "book-list"))[
      #html.elem("li")[
        #html.elem("a", attrs: (href: "./book-main/index.html"))[Project Handbook]
        #html.elem("p", attrs: (class: "desc"))[The main guide to this project — architecture, decisions, and how things work.]
      ]
    ]

    #html.elem("h2")[Journal]
    #html.elem("p")[Daily notes and observations. Each entry is a timestamped document in the stream of work.]
    #html.elem("ul", attrs: (class: "journal-list"))[
      #html.elem("li")[
        #html.elem("a", attrs: (href: "./journal/2026/03/28.html"))[Getting Started with Crow Docs]
        #html.elem("span", attrs: (class: "date"))[2026-03-28]
      ]
    ]
  ]
]
