"use client"

import React, { useState, useCallback, useMemo, useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { ChevronLeft, ChevronRight, Plus, Calendar, Clock, Grid3x3, List, Search, Filter, X } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Glyph } from "@/app/components/Glyph"
import { FILL, RULE } from "@/app/components/Grid"
import type { IntentKind, Priority } from "@/app/lib/api"

export interface Event {
  id: string
  intentId?: string
  title: string
  description?: string
  startTime: Date
  endTime: Date
  color: string
  category?: string
  attendees?: string[]
  tags?: string[]
  /** When set, the card renders the same Glyph + accent-tint left-rule
   *  system every other view (Grid, Inbox, Analytics) uses for priority and
   *  kind, instead of the generic named `color`. Left unset for an wydarzenie
   *  with no priority of its own (a real, external, immovable meeting) —
   *  see `busyToEvents` in `app/planner/page.tsx`. */
  priority?: Priority
  kind?: IntentKind
  completed?: boolean
  recurring?: boolean
}

export interface EventManagerProps {
  wydarzeń?: Event[]
  onEventCreate?: (wydarzenie: Omit<Event, "id">) => void
  onEventUpdate?: (id: string, wydarzenie: Partial<Event>) => void
  onEventDelete?: (id: string) => void
  onEventComplete?: (wydarzenie: Event) => void | Promise<void>
  categories?: string[]
  colors?: { name: string; value: string; bg: string; text: string }[]
  defaultView?: "month" | "week" | "day" | "list"
  className?: string
  availableTags?: string[]
}

const defaultColors = [
  { name: "Niebieski", value: "blue", bg: "bg-blue-500", text: "text-blue-700" },
  { name: "Zielony", value: "green", bg: "bg-green-500", text: "text-green-700" },
  { name: "Fioletowy", value: "purple", bg: "bg-purple-500", text: "text-purple-700" },
  { name: "Pomarańczowy", value: "orange", bg: "bg-orange-500", text: "text-orange-700" },
  { name: "Różowy", value: "pink", bg: "bg-pink-500", text: "text-pink-700" },
  { name: "Czerwony", value: "red", bg: "bg-red-500", text: "text-red-700" },
]

export function EventManager({
  wydarzeń = [],
  onEventCreate,
  onEventUpdate,
  onEventDelete,
  onEventComplete,
  categories = ["Spotkanie", "Zadanie", "Przypomnienie", "Osobiste"],
  colors = defaultColors,
  defaultView = "month",
  className,
  availableTags = ["Ważne", "Pilne", "Praca", "Osobiste", "Zespół", "Klient"],
}: EventManagerProps) {
  const [currentDate, setCurrentDate] = useState(new Date())
  const [view, setView] = useState<"month" | "week" | "day" | "list">(defaultView)
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const draggedEventRef = useRef<Event | null>(null)
  const defaultColor = colors[0]?.value ?? "blue"
  const defaultCategory = categories[0] ?? "Spotkanie"
  const [newEvent, setNewEvent] = useState<Partial<Event>>({
    title: "",
    description: "",
    color: defaultColor,
    category: defaultCategory,
    tags: [],
  })

  const [searchQuery, setSearchQuery] = useState("")
  const [selectedColors, setSelectedColors] = useState<string[]>([])
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])

  const filteredEvents = useMemo(() => {
    return wydarzeń.filter((wydarzenie) => {
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase()
        const matchesSearch =
          wydarzenie.title.toLowerCase().includes(query) ||
          wydarzenie.description?.toLowerCase().includes(query) ||
          wydarzenie.category?.toLowerCase().includes(query) ||
          wydarzenie.tags?.some((tag) => tag.toLowerCase().includes(query))

        if (!matchesSearch) return false
      }

      // Color filter
      if (selectedColors.length > 0 && !selectedColors.includes(wydarzenie.color)) {
        return false
      }

      // Tag filter
      if (selectedTags.length > 0) {
        const hasMatchingTag = wydarzenie.tags?.some((tag) => selectedTags.includes(tag))
        if (!hasMatchingTag) return false
      }

      // Category filter
      if (selectedCategories.length > 0 && wydarzenie.category && !selectedCategories.includes(wydarzenie.category)) {
        return false
      }

      return true
    })
  }, [wydarzeń, searchQuery, selectedColors, selectedTags, selectedCategories])

  const hasActiveFilters = selectedColors.length > 0 || selectedTags.length > 0 || selectedCategories.length > 0

  const clearFilters = () => {
    setSelectedColors([])
    setSelectedTags([])
    setSelectedCategories([])
    setSearchQuery("")
  }

  const handleCreateEvent = useCallback(() => {
    if (!newEvent.title || !newEvent.startTime || !newEvent.endTime) return

    const wydarzenie: Event = {
      id: Math.random().toString(36).substr(2, 9),
      title: newEvent.title,
      description: newEvent.description,
      startTime: newEvent.startTime,
      endTime: newEvent.endTime,
      color: newEvent.color || defaultColor,
      category: newEvent.category,
      attendees: newEvent.attendees,
      tags: newEvent.tags || [],
    }

    onEventCreate?.(wydarzenie)
    setIsDialogOpen(false)
    setIsCreating(false)
    setNewEvent({
      title: "",
      description: "",
      color: defaultColor,
      category: defaultCategory,
      tags: [],
    })
  }, [newEvent, defaultColor, defaultCategory, onEventCreate])

  const handleUpdateEvent = useCallback(() => {
    if (!selectedEvent) return

    onEventUpdate?.(selectedEvent.id, selectedEvent)
    setIsDialogOpen(false)
    setSelectedEvent(null)
  }, [selectedEvent, onEventUpdate])

  const handleDeleteEvent = useCallback(
    (id: string) => {
      onEventDelete?.(id)
      setIsDialogOpen(false)
      setSelectedEvent(null)
    },
    [onEventDelete],
  )

  const handleDragStart = useCallback((wydarzenie: Event) => {
    // Keep native HTML5 drag stable. Updating React state during dragstart can
    // re-render the draggable node and cancel the browser drag operation.
    draggedEventRef.current = wydarzenie
  }, [])

  const handleDragEnd = useCallback(() => {
    draggedEventRef.current = null
  }, [])

  const handleDrop = useCallback(
    (date: Date, hour?: number, wydarzenieId?: string) => {
      const source =
        (wydarzenieId ? wydarzeń.find((wydarzenie) => wydarzenie.id === wydarzenieId) : undefined) ??
        draggedEventRef.current
      if (!source) return

      const duration = source.endTime.getTime() - source.startTime.getTime()
      const newStartTime = new Date(date)

      if (hour !== undefined) {
        newStartTime.setHours(hour, 0, 0, 0)
      } else {
        // Month view changes the day only. Keep the task's existing clock
        // time instead of dropping it at midnight.
        newStartTime.setHours(
          source.startTime.getHours(),
          source.startTime.getMinutes(),
          0,
          0,
        )
      }

      const newEndTime = new Date(newStartTime.getTime() + duration)

      onEventUpdate?.(source.id, {
        ...source,
        startTime: newStartTime,
        endTime: newEndTime,
      })
      draggedEventRef.current = null
    },
    [wydarzeń, onEventUpdate],
  )

  const navigateDate = useCallback(
    (direction: "prev" | "next") => {
      setCurrentDate((prev) => {
        const newDate = new Date(prev)
        if (view === "month") {
          newDate.setMonth(prev.getMonth() + (direction === "next" ? 1 : -1))
        } else if (view === "week") {
          newDate.setDate(prev.getDate() + (direction === "next" ? 7 : -7))
        } else if (view === "day") {
          newDate.setDate(prev.getDate() + (direction === "next" ? 1 : -1))
        }
        return newDate
      })
    },
    [view],
  )

  const fallbackColor = colors[0] ?? { name: "Niebieski", value: "blue", bg: "bg-blue-500", text: "text-blue-700" }
  const getColorClasses = useCallback(
    (colorValue: string): { name: string; value: string; bg: string; text: string } => {
      const color = colors.find((c) => c.value === colorValue)
      return color ?? fallbackColor
    },
    [colors, fallbackColor],
  )

  const toggleTag = (tag: string, isCreating: boolean) => {
    if (isCreating) {
      setNewEvent((prev) => ({
        ...prev,
        tags: prev.tags?.includes(tag) ? prev.tags.filter((t) => t !== tag) : [...(prev.tags || []), tag],
      }))
    } else {
      setSelectedEvent((prev) =>
        prev
          ? {
              ...prev,
              tags: prev.tags?.includes(tag) ? prev.tags.filter((t) => t !== tag) : [...(prev.tags || []), tag],
            }
          : null,
      )
    }
  }

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
          <h2 className="text-xl font-semibold sm:text-2xl">
            {view === "month" &&
              currentDate.toLocaleDateString("pl-PL", {
                month: "long",
                year: "numeric",
              })}
            {view === "week" &&
              `Tydzień od ${currentDate.toLocaleDateString("pl-PL", {
                month: "short",
                day: "numeric",
              })}`}
            {view === "day" &&
              currentDate.toLocaleDateString("pl-PL", {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            {view === "list" && "Wszystkie wydarzenia"}
          </h2>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={() => navigateDate("prev")} className="h-8 w-8">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => setCurrentDate(new Date())}>
              Today
            </Button>
            <Button variant="outline" size="icon" onClick={() => navigateDate("next")} className="h-8 w-8">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {/* Mobile: direct view switcher. A native-width select used to open
              over the search/filter row on narrow screens, so all four views
              are now one tap away without an overlay. */}
          <div className="grid grid-cols-4 gap-1 rounded-xl border bg-background p-1 sm:hidden">
            {[
              { value: "month", label: "Miesiąc", icon: Calendar },
              { value: "week", label: "Tydzień", icon: Grid3x3 },
              { value: "day", label: "Dzień", icon: Clock },
              { value: "list", label: "Lista", icon: List },
            ].map((item) => {
              const Icon = item.icon
              const active = view === item.value
              return (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setView(item.value as "month" | "week" | "day" | "list")}
                  className={cn(
                    "flex min-h-10 items-center justify-center gap-1 rounded-lg px-1.5 text-[11px] font-semibold transition-colors",
                    active ? "bg-secondary text-foreground shadow-sm" : "text-muted-foreground",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </div>

          {/* Desktop: Button group */}
          <div className="hidden sm:flex items-center gap-1 rounded-lg border bg-background p-1">
            <Button
              variant={view === "month" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setView("month")}
              className="h-8"
            >
              <Calendar className="h-4 w-4" />
              <span className="ml-1">Miesiąc</span>
            </Button>
            <Button
              variant={view === "week" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setView("week")}
              className="h-8"
            >
              <Grid3x3 className="h-4 w-4" />
              <span className="ml-1">Tydzień</span>
            </Button>
            <Button
              variant={view === "day" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setView("day")}
              className="h-8"
            >
              <Clock className="h-4 w-4" />
              <span className="ml-1">Dzień</span>
            </Button>
            <Button
              variant={view === "list" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setView("list")}
              className="h-8"
            >
              <List className="h-4 w-4" />
              <span className="ml-1">Lista</span>
            </Button>
          </div>

          <Button
            onClick={() => {
              setIsCreating(true)
              setIsDialogOpen(true)
            }}
            className="h-10 w-full rounded-xl sm:w-auto"
          >
            <Plus className="mr-2 h-4 w-4" />
            Nowe wydarzenie
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Szukaj wydarzeń..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
          {searchQuery && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
              onClick={() => setSearchQuery("")}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>

        {/* Mobile: Horizontal scroll with full-length buttons */}
        <div className="sm:hidden -mx-4 px-4">
          <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
            {/* Color Filter */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2 whitespace-nowrap flex-shrink-0 bg-transparent">
                  <Filter className="h-4 w-4" />
                  Colors
                  {selectedColors.length > 0 && (
                    <Badge variant="secondary" className="ml-1 h-5 px-1.5">
                      {selectedColors.length}
                    </Badge>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48 bg-white">
                <DropdownMenuLabel>Filtruj według koloru</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {colors.map((color) => (
                  <DropdownMenuCheckboxItem
                    key={color.value}
                    checked={selectedColors.includes(color.value)}
                    onCheckedChange={(checked) => {
                      setSelectedColors((prev) =>
                        checked ? [...prev, color.value] : prev.filter((c) => c !== color.value),
                      )
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <div className={cn("h-3 w-3 rounded", color.bg)} />
                      {color.name}
                    </div>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Tag Filter */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2 whitespace-nowrap flex-shrink-0 bg-transparent">
                  <Filter className="h-4 w-4" />
                  Tags
                  {selectedTags.length > 0 && (
                    <Badge variant="secondary" className="ml-1 h-5 px-1.5">
                      {selectedTags.length}
                    </Badge>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48 bg-white">
                <DropdownMenuLabel>Filtruj według tagu</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {availableTags.map((tag) => (
                  <DropdownMenuCheckboxItem
                    key={tag}
                    checked={selectedTags.includes(tag)}
                    onCheckedChange={(checked) => {
                      setSelectedTags((prev) => (checked ? [...prev, tag] : prev.filter((t) => t !== tag)))
                    }}
                  >
                    {tag}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Category Filter */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2 whitespace-nowrap flex-shrink-0 bg-transparent">
                  <Filter className="h-4 w-4" />
                  Categories
                  {selectedCategories.length > 0 && (
                    <Badge variant="secondary" className="ml-1 h-5 px-1.5">
                      {selectedCategories.length}
                    </Badge>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48 bg-white">
                <DropdownMenuLabel>Filtruj według kategorii</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {categories.map((category) => (
                  <DropdownMenuCheckboxItem
                    key={category}
                    checked={selectedCategories.includes(category)}
                    onCheckedChange={(checked) => {
                      setSelectedCategories((prev) =>
                        checked ? [...prev, category] : prev.filter((c) => c !== category),
                      )
                    }}
                  >
                    {category}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                className="gap-2 whitespace-nowrap flex-shrink-0"
              >
                <X className="h-4 w-4" />
                Wyczyść filtry
              </Button>
            )}
          </div>
        </div>

        {/* Desktop: Original layout */}
        <div className="hidden sm:flex items-center gap-2">
          {/* Color Filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2 bg-transparent">
                <Filter className="h-4 w-4" />
                Colors
                {selectedColors.length > 0 && (
                  <Badge variant="secondary" className="ml-1 h-5 px-1">
                    {selectedColors.length}
                  </Badge>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48 bg-white">
              <DropdownMenuLabel>Filtruj według koloru</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {colors.map((color) => (
                <DropdownMenuCheckboxItem
                  key={color.value}
                  checked={selectedColors.includes(color.value)}
                  onCheckedChange={(checked) => {
                    setSelectedColors((prev) =>
                      checked ? [...prev, color.value] : prev.filter((c) => c !== color.value),
                    )
                  }}
                >
                  <div className="flex items-center gap-2">
                    <div className={cn("h-3 w-3 rounded", color.bg)} />
                    {color.name}
                  </div>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Tag Filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2 bg-transparent">
                <Filter className="h-4 w-4" />
                Tags
                {selectedTags.length > 0 && (
                  <Badge variant="secondary" className="ml-1 h-5 px-1">
                    {selectedTags.length}
                  </Badge>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48 bg-white">
              <DropdownMenuLabel>Filtruj według tagu</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {availableTags.map((tag) => (
                <DropdownMenuCheckboxItem
                  key={tag}
                  checked={selectedTags.includes(tag)}
                  onCheckedChange={(checked) => {
                    setSelectedTags((prev) => (checked ? [...prev, tag] : prev.filter((t) => t !== tag)))
                  }}
                >
                  {tag}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Category Filter */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2 bg-transparent">
                <Filter className="h-4 w-4" />
                Categories
                {selectedCategories.length > 0 && (
                  <Badge variant="secondary" className="ml-1 h-5 px-1">
                    {selectedCategories.length}
                  </Badge>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48 bg-white">
              <DropdownMenuLabel>Filtruj według kategorii</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {categories.map((category) => (
                <DropdownMenuCheckboxItem
                  key={category}
                  checked={selectedCategories.includes(category)}
                  onCheckedChange={(checked) => {
                    setSelectedCategories((prev) =>
                      checked ? [...prev, category] : prev.filter((c) => c !== category),
                    )
                  }}
                >
                  {category}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="gap-2">
              <X className="h-4 w-4" />
              Clear
            </Button>
          )}
        </div>
      </div>

      {hasActiveFilters && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Active filters:</span>
          {selectedColors.map((colorValue) => {
            const color = getColorClasses(colorValue)
            return (
              <Badge key={colorValue} variant="secondary" className="gap-1">
                <div className={cn("h-2 w-2 rounded-full", color.bg)} />
                {color.name}
                <button
                  onClick={() => setSelectedColors((prev) => prev.filter((c) => c !== colorValue))}
                  aria-label={`Remove ${color.name} filter`}
                  className="ml-1 hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            )
          })}
          {selectedTags.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1">
              {tag}
              <button
                onClick={() => setSelectedTags((prev) => prev.filter((t) => t !== tag))}
                aria-label={`Remove ${tag} filter`}
                className="ml-1 hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          {selectedCategories.map((category) => (
            <Badge key={category} variant="secondary" className="gap-1">
              {category}
              <button
                onClick={() => setSelectedCategories((prev) => prev.filter((c) => c !== category))}
                aria-label={`Remove ${category} filter`}
                className="ml-1 hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {/* Calendar Views - Pass filteredEvents instead of wydarzeń */}
      {view === "month" && (
        <MonthView
          currentDate={currentDate}
          wydarzeń={filteredEvents}
          onEventClick={(wydarzenie) => {
            setSelectedEvent(wydarzenie)
            setIsDialogOpen(true)
          }}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDrop={handleDrop}
          getColorClasses={getColorClasses}
        />
      )}

      {view === "week" && (
        <WeekView
          currentDate={currentDate}
          wydarzeń={filteredEvents}
          onEventClick={(wydarzenie) => {
            setSelectedEvent(wydarzenie)
            setIsDialogOpen(true)
          }}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDrop={handleDrop}
          getColorClasses={getColorClasses}
        />
      )}

      {view === "day" && (
        <DayView
          currentDate={currentDate}
          wydarzeń={filteredEvents}
          onEventClick={(wydarzenie) => {
            setSelectedEvent(wydarzenie)
            setIsDialogOpen(true)
          }}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDrop={handleDrop}
          getColorClasses={getColorClasses}
        />
      )}

      {view === "list" && (
        <ListView
          wydarzeń={filteredEvents}
          onEventClick={(wydarzenie) => {
            setSelectedEvent(wydarzenie)
            setIsDialogOpen(true)
          }}
          getColorClasses={getColorClasses}
        />
      )}

      {/* Event Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto bg-white">
          <DialogHeader>
            <DialogTitle>{isCreating ? "Create Event" : "Szczegóły wydarzenia"}</DialogTitle>
            <DialogDescription>
              {isCreating ? "Add a new wydarzenie to your calendar" : "Wyświetl i edytuj szczegóły wydarzenia"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">Tytuł</Label>
              <Input
                id="title"
                value={isCreating ? newEvent.title : selectedEvent?.title || ""}
                onChange={(e) =>
                  isCreating
                    ? setNewEvent((prev) => ({ ...prev, title: e.target.value }))
                    : setSelectedEvent((prev) => (prev ? { ...prev, title: e.target.value } : null))
                }
                placeholder="Event title"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Opis</Label>
              <Textarea
                id="description"
                value={isCreating ? newEvent.description : selectedEvent?.description || ""}
                onChange={(e) =>
                  isCreating
                    ? setNewEvent((prev) => ({
                        ...prev,
                        description: e.target.value,
                      }))
                    : setSelectedEvent((prev) => (prev ? { ...prev, description: e.target.value } : null))
                }
                placeholder="Event description"
                rows={3}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startTime">Początek</Label>
                <Input
                  id="startTime"
                  type="datetime-local"
                  step={900}
                  value={
                    isCreating
                      ? newEvent.startTime
                        ? new Date(newEvent.startTime.getTime() - newEvent.startTime.getTimezoneOffset() * 60000)
                            .toISOString()
                            .slice(0, 16)
                        : ""
                      : selectedEvent?.startTime
                        ? new Date(
                            selectedEvent.startTime.getTime() - selectedEvent.startTime.getTimezoneOffset() * 60000,
                          )
                            .toISOString()
                            .slice(0, 16)
                        : ""
                  }
                  onChange={(e) => {
                    const date = new Date(e.target.value)
                    isCreating
                      ? setNewEvent((prev) => ({ ...prev, startTime: date }))
                      : setSelectedEvent((prev) => (prev ? { ...prev, startTime: date } : null))
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="endTime">Koniec</Label>
                <Input
                  id="endTime"
                  type="datetime-local"
                  step={900}
                  value={
                    isCreating
                      ? newEvent.endTime
                        ? new Date(newEvent.endTime.getTime() - newEvent.endTime.getTimezoneOffset() * 60000)
                            .toISOString()
                            .slice(0, 16)
                        : ""
                      : selectedEvent?.endTime
                        ? new Date(selectedEvent.endTime.getTime() - selectedEvent.endTime.getTimezoneOffset() * 60000)
                            .toISOString()
                            .slice(0, 16)
                        : ""
                  }
                  onChange={(e) => {
                    const date = new Date(e.target.value)
                    isCreating
                      ? setNewEvent((prev) => ({ ...prev, endTime: date }))
                      : setSelectedEvent((prev) => (prev ? { ...prev, endTime: date } : null))
                  }}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="category">Kategoria</Label>
                <Select
                  value={isCreating ? newEvent.category : selectedEvent?.category}
                  onValueChange={(value) =>
                    isCreating
                      ? setNewEvent((prev) => ({ ...prev, category: value }))
                      : setSelectedEvent((prev) => (prev ? { ...prev, category: value } : null))
                  }
                >
                  <SelectTrigger id="category" className="bg-white">
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent className="bg-white z-[999]">
                    {categories.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="color">Kolor</Label>
                <Select
                  value={isCreating ? newEvent.color : selectedEvent?.color}
                  onValueChange={(value) =>
                    isCreating
                      ? setNewEvent((prev) => ({ ...prev, color: value }))
                      : setSelectedEvent((prev) => (prev ? { ...prev, color: value } : null))
                  }
                >
                  <SelectTrigger id="color" className="bg-white">
                    <SelectValue placeholder="Select color" />
                  </SelectTrigger>
                  <SelectContent className="bg-white z-[999]">
                    {colors.map((color) => (
                      <SelectItem key={color.value} value={color.value}>
                        <div className="flex items-center gap-2">
                          <div className={cn("h-4 w-4 rounded", color.bg)} />
                          {color.name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Tagi</Label>
              <div className="flex flex-wrap gap-2">
                {availableTags.map((tag) => {
                  const isSelected = isCreating ? newEvent.tags?.includes(tag) : selectedEvent?.tags?.includes(tag)
                  return (
                    <Badge
                      key={tag}
                      variant={isSelected ? "default" : "outline"}
                      className="cursor-pointer transition-all hover:scale-105"
                      onClick={() => toggleTag(tag, isCreating)}
                    >
                      {tag}
                    </Badge>
                  )
                })}
              </div>
            </div>
          </div>

          <DialogFooter>
            {!isCreating &&
              selectedEvent &&
              (selectedEvent.kind === "task" || selectedEvent.kind === "habit") &&
              onEventComplete && (
                <Button
                  variant="outline"
                  onClick={async () => {
                    await onEventComplete(selectedEvent)
                    setIsDialogOpen(false)
                    setSelectedEvent(null)
                  }}
                  className={
                    selectedEvent.completed
                      ? "border-black/[0.10]"
                      : "border-green-200 bg-green-50 text-green-700 hover:bg-green-100"
                  }
                >
                  {selectedEvent.completed ? "↶ Undo completion" : "✓ Mark complete"}
                </Button>
              )}

            {!isCreating && (
              <Button variant="destructive" onClick={() => selectedEvent && handleDeleteEvent(selectedEvent.id)}>
                Delete
              </Button>
            )}

            <Button
              variant="outline"
              onClick={() => {
                setIsDialogOpen(false)
                setIsCreating(false)
                setSelectedEvent(null)
              }}
            >
              Cancel
            </Button>
            <Button onClick={isCreating ? handleCreateEvent : handleUpdateEvent}>
              {isCreating ? "Create" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// EventCard component with hover effect
function EventCard({
  wydarzenie,
  onEventClick,
  onDragStart,
  onDragEnd,
  getColorClasses,
  variant = "default",
}: {
  wydarzenie: Event
  onEventClick: (wydarzenie: Event) => void
  onDragStart: (wydarzenie: Event) => void
  onDragEnd: () => void
  getColorClasses: (color: string) => { bg: string; text: string }
  variant?: "default" | "compact" | "detailed"
}) {
  const [isHovered, setIsHovered] = useState(false)
  const colorClasses = getColorClasses(wydarzenie.color)

  // A block with a priority renders the same Glyph + accent-tint left-rule
  // system Grid.tsx (the /time page) uses, instead of the generic named
  // `color` — one source of truth for what priority/kind look like,
  // wherever a block is drawn. An wydarzenie with no priority (a real, external,
  // immovable meeting) keeps the plain `colorClasses` treatment.
  const priority = wydarzenie.priority
  const moved = wydarzenie.tags?.includes("Moved") ?? false
  const ruleColor = priority ? RULE[priority] : undefined
  const priorityStyle: React.CSSProperties | undefined = priority
    ? { backgroundColor: FILL[priority], borderLeft: `3px ${moved ? "dashed" : "solid"} ${RULE[priority]}` }
    : undefined
  const bgClass = priority ? undefined : colorClasses.bg
  const textClass = priority ? "text-fg" : "text-white"

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString("pl-PL", {
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  const getDuration = () => {
    const diff = wydarzenie.endTime.getTime() - wydarzenie.startTime.getTime()
    const hours = Math.floor(diff / (1000 * 60 * 60))
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
    if (hours > 0) {
      return `${hours}h ${minutes}m`
    }
    return `${minutes}m`
  }

  const dot = (size: "h-3 w-3" | "h-4 w-4") => (
    <div
      className={cn(size, "flex-shrink-0 rounded-full", !priority && colorClasses.bg)}
      style={priority ? { background: ruleColor } : undefined}
    />
  )

  const kindGlyph = (size: number) =>
    wydarzenie.kind && (
      <span className="shrink-0" style={{ color: ruleColor }} aria-hidden>
        <Glyph kind={wydarzenie.kind} size={size} />
      </span>
    )

  if (variant === "compact") {
    return (
      <div
        draggable
        onDragStart={(nativeEvent) => {
          nativeEvent.dataTransfer.effectAllowed = "move"
          nativeEvent.dataTransfer.setData("application/x-horolog-wydarzenie", wydarzenie.id)
          nativeEvent.dataTransfer.setData("text/plain", wydarzenie.id)
          onDragStart(wydarzenie)
        }}
        onDragEnd={onDragEnd}
        onClick={() => onEventClick(wydarzenie)}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className="relative cursor-pointer"
      >
        <div
          style={priorityStyle}
          className={cn(
            "flex items-center gap-1 truncate rounded px-1.5 py-0.5 text-xs font-medium transition-all duration-300",
            bgClass,
            textClass,
            "animate-in fade-in slide-in-from-top-1",
            isHovered && "scale-105 shadow-lg z-10",
            wydarzenie.completed && "opacity-70",
          )}
        >
          {wydarzenie.completed && (
            <span className="shrink-0 font-bold" aria-label="Completed">✓</span>
          )}
          {kindGlyph(10)}
          <span className={cn("truncate", wydarzenie.completed && "line-through opacity-60")}>
            {wydarzenie.title}
          </span>
        </div>
        {isHovered && (
          <div className="absolute left-0 top-full z-50 mt-1 w-64 animate-in fade-in slide-in-from-top-2 duration-200">
            <Card className="border-2 p-3 shadow-xl bg-white text-fg">
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <h4 className={cn(
                    "font-semibold text-sm leading-tight text-fg",
                    wydarzenie.completed && "line-through opacity-60",
                  )}>
                    {wydarzenie.completed ? "✓ " : ""}{wydarzenie.title}
                  </h4>
                  {dot("h-3 w-3")}
                </div>
                {wydarzenie.description && <p className="text-xs text-muted-foreground line-clamp-2">{wydarzenie.description}</p>}
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  <span>
                    {formatTime(wydarzenie.startTime)} - {formatTime(wydarzenie.endTime)}
                  </span>
                  <span className="text-[10px]">({getDuration()})</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {wydarzenie.category && (
                    <Badge variant="secondary" className="text-[10px] h-5">
                      {wydarzenie.category}
                    </Badge>
                  )}
                  {wydarzenie.tags?.map((tag) => (
                    <Badge key={tag} variant="outline" className="text-[10px] h-5">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            </Card>
          </div>
        )}
      </div>
    )
  }

  if (variant === "detailed") {
    return (
      <div
        draggable
        onDragStart={(nativeEvent) => {
          nativeEvent.dataTransfer.effectAllowed = "move"
          nativeEvent.dataTransfer.setData("application/x-horolog-wydarzenie", wydarzenie.id)
          nativeEvent.dataTransfer.setData("text/plain", wydarzenie.id)
          onDragStart(wydarzenie)
        }}
        onDragEnd={onDragEnd}
        onClick={() => onEventClick(wydarzenie)}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        style={priorityStyle}
        className={cn(
          "cursor-pointer rounded-lg p-3 transition-all duration-300",
          bgClass,
          textClass,
          "animate-in fade-in slide-in-from-left-2",
          isHovered && "scale-[1.03] shadow-2xl ring-2 ring-black/10",
          wydarzenie.completed && "opacity-70",
        )}
      >
        <div className={cn(
          "flex items-center gap-1.5 font-semibold",
          wydarzenie.completed && "line-through opacity-60",
        )}>
          {wydarzenie.completed && <span className="font-bold">✓</span>}
          {kindGlyph(14)}
          {wydarzenie.title}
        </div>
        {wydarzenie.description && (
          <div className={cn("mt-1 text-sm line-clamp-2", priority ? "text-fg-muted" : "opacity-90")}>
            {wydarzenie.description}
          </div>
        )}
        <div className={cn("mt-2 flex items-center gap-2 text-xs", priority ? "text-fg-muted" : "opacity-80")}>
          <Clock className="h-3 w-3" />
          {formatTime(wydarzenie.startTime)} - {formatTime(wydarzenie.endTime)}
        </div>
        {isHovered && (
          <div className="mt-2 flex flex-wrap gap-1 animate-in fade-in slide-in-from-bottom-1 duration-200">
            {wydarzenie.category && (
              <Badge variant="secondary" className="text-xs">
                {wydarzenie.category}
              </Badge>
            )}
            {wydarzenie.tags?.map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      draggable
      onDragStart={() => onDragStart(wydarzenie)}
      onDragEnd={onDragEnd}
      onClick={() => onEventClick(wydarzenie)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="relative"
    >
      <div
        style={priorityStyle}
        className={cn(
          "flex items-center gap-1.5 cursor-pointer rounded px-2 py-1 text-xs font-medium transition-all duration-300",
          bgClass,
          textClass,
          "animate-in fade-in slide-in-from-left-1",
          isHovered && "scale-105 shadow-lg z-10",
          wydarzenie.completed && "opacity-70",
        )}
      >
        {wydarzenie.completed && (
          <span className="shrink-0 font-bold" aria-label="Completed">✓</span>
        )}
        {kindGlyph(12)}
        <div className={cn("truncate", wydarzenie.completed && "line-through opacity-60")}>
          {wydarzenie.title}
        </div>
      </div>
      {isHovered && (
        <div className="absolute left-0 top-full z-50 mt-1 w-72 animate-in fade-in slide-in-from-top-2 duration-200">
          <Card className="border-2 p-4 shadow-xl bg-white text-fg animate-in fade-in duration-100">
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-2">
                <h4 className={cn(
                  "font-semibold leading-tight text-fg",
                  wydarzenie.completed && "line-through opacity-60",
                )}>
                  {wydarzenie.completed ? "✓ " : ""}{wydarzenie.title}
                </h4>
                {dot("h-4 w-4")}
              </div>
              {wydarzenie.description && <p className="text-sm text-muted-foreground">{wydarzenie.description}</p>}
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  <span>
                    {formatTime(wydarzenie.startTime)} - {formatTime(wydarzenie.endTime)}
                  </span>
                  <span className="text-[10px]">({getDuration()})</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {wydarzenie.category && (
                    <Badge variant="secondary" className="text-xs">
                      {wydarzenie.category}
                    </Badge>
                  )}
                  {wydarzenie.tags?.map((tag) => (
                    <Badge key={tag} variant="outline" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}

// Month View Component
function MonthView({
  currentDate,
  wydarzeń,
  onEventClick,
  onDragStart,
  onDragEnd,
  onDrop,
  getColorClasses,
}: {
  currentDate: Date
  wydarzeń: Event[]
  onEventClick: (wydarzenie: Event) => void
  onDragStart: (wydarzenie: Event) => void
  onDragEnd: () => void
  onDrop: (date: Date, hour?: number, wydarzenieId?: string) => void
  getColorClasses: (color: string) => { bg: string; text: string }
}) {
  const [selectedDay, setSelectedDay] = useState(new Date(currentDate))

  useEffect(() => {
    setSelectedDay(new Date(currentDate))
  }, [currentDate])

  const firstDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1)
  const startDate = new Date(firstDayOfMonth)
  const mondayOffset = (startDate.getDay() + 6) % 7
  startDate.setDate(startDate.getDate() - mondayOffset)

  const days = []
  const currentDay = new Date(startDate)

  for (let i = 0; i < 42; i++) {
    days.push(new Date(currentDay))
    currentDay.setDate(currentDay.getDate() + 1)
  }

  const getEventsForDay = (date: Date) => {
    return wydarzeń.filter((wydarzenie) => {
      const wydarzenieDate = new Date(wydarzenie.startTime)
      return (
        wydarzenieDate.getDate() === date.getDate() &&
        wydarzenieDate.getMonth() === date.getMonth() &&
        wydarzenieDate.getFullYear() === date.getFullYear()
      )
    })
  }

  const selectedEvents = getEventsForDay(selectedDay).sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime(),
  )

  return (
    <>
      {/* Mobile month is intentionally an overview, not a squeezed desktop
          calendar. Tap a day to see the readable agenda directly below. */}
      <div className="space-y-3 sm:hidden">
        <Card className="overflow-hidden bg-white">
          <div className="grid grid-cols-7 border-b bg-muted/20">
            {["M", "T", "W", "T", "F", "S", "S"].map((day, index) => (
              <div
                key={`${day}-${index}`}
                className="py-2 text-center text-[10px] font-semibold text-muted-foreground"
              >
                {day}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {days.map((day, index) => {
              const dayEvents = getEventsForDay(day)
              const isCurrentMonth = day.getMonth() === currentDate.getMonth()
              const isToday = day.toDateString() === new Date().toDateString()
              const isSelected = day.toDateString() === selectedDay.toDateString()

              return (
                <button
                  type="button"
                  key={index}
                  onClick={() => setSelectedDay(new Date(day))}
                  className={cn(
                    "min-h-14 border-b border-r px-1 py-1.5 text-left last:border-r-0",
                    !isCurrentMonth && "bg-muted/20 text-muted-foreground/50",
                    isSelected && "bg-secondary",
                  )}
                >
                  <span
                    className={cn(
                      "mx-auto flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-medium",
                      isToday && "bg-primary font-semibold text-primary-foreground",
                      isSelected && !isToday && "ring-1 ring-border",
                    )}
                  >
                    {day.getDate()}
                  </span>
                  <span className="mt-1 flex h-2 items-center justify-center gap-0.5">
                    {dayEvents.slice(0, 3).map((wydarzenie) => (
                      <span
                        key={wydarzenie.id}
                        className="h-1.5 w-1.5 rounded-full"
                        style={{
                          background: wydarzenie.priority
                            ? RULE[wydarzenie.priority]
                            : undefined,
                        }}
                      />
                    ))}
                    {dayEvents.length > 3 && (
                      <span className="text-[8px] leading-none text-muted-foreground">+</span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        </Card>

        <div className="rounded-xl border bg-white p-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Selected day
              </p>
              <h3 className="text-sm font-semibold text-foreground">
                {selectedDay.toLocaleDateString("pl-PL", {
                  weekday: "long",
                  month: "short",
                  day: "numeric",
                })}
              </h3>
            </div>
            <span className="rounded-full bg-secondary px-2 py-1 text-[10px] font-semibold text-muted-foreground">
              {selectedEvents.length} {selectedEvents.length === 1 ? "wydarzenie" : "wydarzeń"}
            </span>
          </div>

          {selectedEvents.length > 0 ? (
            <div className="space-y-2">
              {selectedEvents.map((wydarzenie) => (
                <EventCard
                  key={wydarzenie.id}
                  wydarzenie={wydarzenie}
                  onEventClick={onEventClick}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  getColorClasses={getColorClasses}
                  variant="detailed"
                />
              ))}
            </div>
          ) : (
            <div className="rounded-lg bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground">
              Brak zaplanowanych wydarzeń na ten dzień.
            </div>
          )}
        </div>
      </div>

      {/* Desktop month view remains unchanged in density and behaviour. */}
      <Card className="hidden overflow-hidden bg-white sm:block">
        <div className="grid grid-cols-7 border-b">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
            <div key={day} className="border-r p-2 text-center text-sm font-medium last:border-r-0">
              {day}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((day, index) => {
            const dayEvents = getEventsForDay(day)
            const isCurrentMonth = day.getMonth() === currentDate.getMonth()
            const isToday = day.toDateString() === new Date().toDateString()

            return (
              <div
                key={index}
                className={cn(
                  "min-h-24 border-b border-r p-2 transition-colors last:border-r-0",
                  !isCurrentMonth && "bg-muted/30",
                  "hover:bg-accent/50",
                )}
                onDragOver={(e) => {
                  e.prwydarzenieDefault()
                  e.dataTransfer.dropEffect = "move"
                }}
                onDrop={(e) => {
                  e.prwydarzenieDefault()
                  onDrop(day, undefined, e.dataTransfer.getData("application/x-horolog-wydarzenie"))
                }}
              >
                <div
                  className={cn(
                    "mb-1 flex h-6 w-6 items-center justify-center rounded-full text-sm",
                    isToday && "bg-primary font-semibold text-primary-foreground",
                  )}
                >
                  {day.getDate()}
                </div>
                <div className="space-y-1">
                  {dayEvents.slice(0, 3).map((wydarzenie) => (
                    <EventCard
                      key={wydarzenie.id}
                      wydarzenie={wydarzenie}
                      onEventClick={onEventClick}
                      onDragStart={onDragStart}
                      onDragEnd={onDragEnd}
                      getColorClasses={getColorClasses}
                      variant="compact"
                    />
                  ))}
                  {dayEvents.length > 3 && (
                    <div className="text-xs text-muted-foreground">+{dayEvents.length - 3} more</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </Card>
    </>
  )
}

// Week View Component
function WeekView({
  currentDate,
  wydarzeń,
  onEventClick,
  onDragStart,
  onDragEnd,
  onDrop,
  getColorClasses,
}: {
  currentDate: Date
  wydarzeń: Event[]
  onEventClick: (wydarzenie: Event) => void
  onDragStart: (wydarzenie: Event) => void
  onDragEnd: () => void
  onDrop: (date: Date, hour: number, wydarzenieId?: string) => void
  getColorClasses: (color: string) => { bg: string; text: string }
}) {
  const startOfWeek = new Date(currentDate)
  const mondayOffset = (currentDate.getDay() + 6) % 7
  startOfWeek.setDate(currentDate.getDate() - mondayOffset)

  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(startOfWeek)
    day.setDate(startOfWeek.getDate() + i)
    return day
  })

  const hours = Array.from({ length: 24 }, (_, i) => i)

  const getEventsForDay = (date: Date) =>
    wydarzeń
      .filter((wydarzenie) => {
        const wydarzenieDate = new Date(wydarzenie.startTime)
        return (
          wydarzenieDate.getDate() === date.getDate() &&
          wydarzenieDate.getMonth() === date.getMonth() &&
          wydarzenieDate.getFullYear() === date.getFullYear()
        )
      })
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())

  const getEventsForDayAndHour = (date: Date, hour: number) => {
    return wydarzeń.filter((wydarzenie) => {
      const wydarzenieDate = new Date(wydarzenie.startTime)
      const wydarzenieHour = wydarzenieDate.getHours()
      return (
        wydarzenieDate.getDate() === date.getDate() &&
        wydarzenieDate.getMonth() === date.getMonth() &&
        wydarzenieDate.getFullYear() === date.getFullYear() &&
        wydarzenieHour === hour
      )
    })
  }

  return (
    <>
      {/* A seven-column hourly grid is unreadable on a phone. Mobile week is
          therefore a chronological agenda grouped by day. */}
      <div className="space-y-3 sm:hidden">
        {weekDays.map((day) => {
          const dayEvents = getEventsForDay(day)
          const isToday = day.toDateString() === new Date().toDateString()
          return (
            <section key={day.toISOString()} className="rounded-xl border bg-white p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold",
                      isToday ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground",
                    )}
                  >
                    {day.getDate()}
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold">
                      {day.toLocaleDateString("pl-PL", { weekday: "long" })}
                    </h3>
                    <p className="text-[10px] text-muted-foreground">
                      {day.toLocaleDateString("pl-PL", { month: "short", day: "numeric" })}
                    </p>
                  </div>
                </div>
                <span className="text-[10px] font-medium text-muted-foreground">
                  {dayEvents.length || "No"} {dayEvents.length === 1 ? "wydarzenie" : "wydarzeń"}
                </span>
              </div>
              {dayEvents.length > 0 ? (
                <div className="space-y-2">
                  {dayEvents.map((wydarzenie) => (
                    <EventCard
                      key={wydarzenie.id}
                      wydarzenie={wydarzenie}
                      onEventClick={onEventClick}
                      onDragStart={onDragStart}
                      onDragEnd={onDragEnd}
                      getColorClasses={getColorClasses}
                      variant="detailed"
                    />
                  ))}
                </div>
              ) : (
                <div className="rounded-lg bg-muted/20 px-3 py-3 text-center text-[11px] text-muted-foreground">
                  Open
                </div>
              )}
            </section>
          )
        })}
      </div>

      <Card className="hidden overflow-auto bg-white sm:block">
        <div className="grid grid-cols-8 border-b">
          <div className="border-r p-2 text-center text-sm font-medium">Time</div>
          {weekDays.map((day) => (
            <div
              key={day.toISOString()}
              className="border-r p-2 text-center text-sm font-medium last:border-r-0"
            >
              <div>{day.toLocaleDateString("pl-PL", { weekday: "short" })}</div>
              <div className="text-xs text-muted-foreground">
                {day.toLocaleDateString("pl-PL", { month: "short", day: "numeric" })}
              </div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-8">
          {hours.map((hour) => (
            <React.Fragment key={`row-${hour}`}>
              <div className="border-b border-r p-2 text-xs text-muted-foreground">
                {hour.toString().padStart(2, "0")}:00
              </div>
              {weekDays.map((day) => {
                const dayEvents = getEventsForDayAndHour(day, hour)
                return (
                  <div
                    key={`${day.toISOString()}-${hour}`}
                    className="min-h-16 border-b border-r p-1 transition-colors hover:bg-accent/50 last:border-r-0"
                    onDragOver={(e) => {
                      e.prwydarzenieDefault()
                      e.dataTransfer.dropEffect = "move"
                    }}
                    onDrop={(e) => {
                      e.prwydarzenieDefault()
                      onDrop(
                        day,
                        hour,
                        e.dataTransfer.getData("application/x-horolog-wydarzenie"),
                      )
                    }}
                  >
                    <div className="space-y-1">
                      {dayEvents.map((wydarzenie) => (
                        <EventCard
                          key={wydarzenie.id}
                          wydarzenie={wydarzenie}
                          onEventClick={onEventClick}
                          onDragStart={onDragStart}
                          onDragEnd={onDragEnd}
                          getColorClasses={getColorClasses}
                          variant="default"
                        />
                      ))}
                    </div>
                  </div>
                )
              })}
            </React.Fragment>
          ))}
        </div>
      </Card>
    </>
  )
}

// Day View Component
function DayView({
  currentDate,
  wydarzeń,
  onEventClick,
  onDragStart,
  onDragEnd,
  onDrop,
  getColorClasses,
}: {
  currentDate: Date
  wydarzeń: Event[]
  onEventClick: (wydarzenie: Event) => void
  onDragStart: (wydarzenie: Event) => void
  onDragEnd: () => void
  onDrop: (date: Date, hour: number, wydarzenieId?: string) => void
  getColorClasses: (color: string) => { bg: string; text: string }
}) {
  const hours = Array.from({ length: 24 }, (_, i) => i)

  const getEventsForHour = (hour: number) => {
    return wydarzeń.filter((wydarzenie) => {
      const wydarzenieDate = new Date(wydarzenie.startTime)
      const wydarzenieHour = wydarzenieDate.getHours()
      return (
        wydarzenieDate.getDate() === currentDate.getDate() &&
        wydarzenieDate.getMonth() === currentDate.getMonth() &&
        wydarzenieDate.getFullYear() === currentDate.getFullYear() &&
        wydarzenieHour === hour
      )
    })
  }

  return (
    <Card className="overflow-auto bg-white">
      <div className="space-y-0">
        {hours.map((hour) => {
          const hourEvents = getEventsForHour(hour)
          return (
            <div
              key={hour}
              className="flex border-b last:border-b-0"
              onDragOver={(e) => {
                e.prwydarzenieDefault()
                e.dataTransfer.dropEffect = "move"
              }}
              onDrop={(e) => {
                e.prwydarzenieDefault()
                onDrop(
                  currentDate,
                  hour,
                  e.dataTransfer.getData("application/x-horolog-wydarzenie"),
                )
              }}
            >
              <div className="w-14 flex-shrink-0 border-r p-2 text-xs text-muted-foreground sm:w-20 sm:p-3 sm:text-sm">
                {hour.toString().padStart(2, "0")}:00
              </div>
              <div className="min-h-16 flex-1 p-1 transition-colors hover:bg-accent/50 sm:min-h-20 sm:p-2">
                <div className="space-y-2">
                  {hourEvents.map((wydarzenie) => (
                    <EventCard
                      key={wydarzenie.id}
                      wydarzenie={wydarzenie}
                      onEventClick={onEventClick}
                      onDragStart={onDragStart}
                      onDragEnd={onDragEnd}
                      getColorClasses={getColorClasses}
                      variant="detailed"
                    />
                  ))}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// List View Component
function ListView({
  wydarzeń,
  onEventClick,
  getColorClasses,
}: {
  wydarzeń: Event[]
  onEventClick: (wydarzenie: Event) => void
  getColorClasses: (color: string) => { bg: string; text: string }
}) {
  const sortedEvents = [...wydarzeń].sort((a, b) => a.startTime.getTime() - b.startTime.getTime())

  const groupedEvents = sortedEvents.reduce(
    (acc, wydarzenie) => {
      const dateKey = wydarzenie.startTime.toLocaleDateString("pl-PL", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      })
      if (!acc[dateKey]) {
        acc[dateKey] = []
      }
      acc[dateKey].push(wydarzenie)
      return acc
    },
    {} as Record<string, Event[]>,
  )

  return (
    <Card className="p-3 sm:p-4 bg-white">
      <div className="space-y-6">
        {Object.entries(groupedEvents).map(([date, dateEvents]) => (
          <div key={date} className="space-y-3">
            <h3 className="text-xs font-semibold text-muted-foreground sm:text-sm">{date}</h3>
            <div className="space-y-2">
              {dateEvents.map((wydarzenie) => {
                const colorClasses = getColorClasses(wydarzenie.color)
                const ruleColor = wydarzenie.priority ? RULE[wydarzenie.priority] : undefined
                return (
                  <div
                    key={wydarzenie.id}
                    onClick={() => onEventClick(wydarzenie)}
                    className="group cursor-pointer rounded-lg border bg-card p-3 transition-all hover:shadow-md hover:scale-[1.01] animate-in fade-in slide-in-from-bottom-2 duration-300 sm:p-4"
                  >
                    <div className="flex items-start gap-2 sm:gap-3">
                      <div
                        className={cn("mt-1 h-2.5 w-2.5 shrink-0 rounded-full sm:h-3 sm:w-3", !wydarzenie.priority && colorClasses.bg)}
                        style={wydarzenie.priority ? { background: ruleColor } : undefined}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <h4 className="flex items-center gap-1.5 font-semibold text-sm group-hover:text-primary transition-colors sm:text-base">
                              {wydarzenie.kind && (
                                <span className="shrink-0" style={{ color: ruleColor }} aria-hidden>
                                  <Glyph kind={wydarzenie.kind} size={13} />
                                </span>
                              )}
                              <span className="truncate">{wydarzenie.title}</span>
                            </h4>
                            {wydarzenie.description && (
                              <p className="mt-1 text-xs text-muted-foreground sm:text-sm line-clamp-2">
                                {wydarzenie.description}
                              </p>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {wydarzenie.category && (
                              <Badge variant="secondary" className="text-xs">
                                {wydarzenie.category}
                              </Badge>
                            )}
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground sm:gap-4 sm:text-xs">
                          <div className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {wydarzenie.startTime.toLocaleTimeString("pl-PL", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}{" "}
                            -{" "}
                            {wydarzenie.endTime.toLocaleTimeString("pl-PL", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </div>
                          {wydarzenie.tags && wydarzenie.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {wydarzenie.tags.map((tag) => (
                                <Badge key={tag} variant="outline" className="text-[10px] h-4 sm:text-xs sm:h-5">
                                  {tag}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
        {sortedEvents.length === 0 && (
          <div className="py-12 text-center text-sm text-muted-foreground sm:text-base">No wydarzeń found</div>
        )}
      </div>
    </Card>
  )
}
