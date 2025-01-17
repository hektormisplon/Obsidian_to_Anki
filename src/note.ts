import { FormatConverter } from './format'
import { AnkiConnectNote, AnkiConnectNoteAndID } from './interfaces/note-interface'
import { FIELDS_DICT, FROZEN_FIELDS_DICT } from './interfaces/field-interface'
import { FileData } from './interfaces/settings-interface'
import { OBS_TAG_REGEXP, ANKI_CLOZE_REGEXP } from './constants'

/*
 * Manages parsing notes into a dictionary formatted for AnkiConnect.
 *
 * Input must be the note text.
 * Does NOT deal with finding the note in the file.
 */

const TAG_PREFIX = 'Tags: '
export const TAG_SEP = ' '
export const ID_REGEXP_STR: string = String.raw`\n?(?:<!--)?(?:ID: (\d+).*)`
export const TAG_REGEXP_STR: string = String.raw`(Tags: .*)`
export const CLOZE_ERROR = 42
export const NOTE_TYPE_ERROR = 69

/*
 * Match cloze syntax in a given string
 *
 * e.g. The string `This a  a{{c1::cloze}}.` would return `true`
 * e.g. The string `This not.` would return `false`
 */

const matchCloze = (s: string): boolean => ANKI_CLOZE_REGEXP.test(s)

/*
 * Checks whether any field of a note contains at least one cloze, return true
 * as soon a cloze is detected
 */

const containsCloze = (note: AnkiConnectNote): boolean =>
  Object.values(note.fields).some(matchCloze)

abstract class AbstractNote {
  text: string
  split_text: string[]
  current_field_num: number
  delete: boolean
  identifier: number | null
  tags: string[]
  note_type: string
  field_names: string[]
  current_field: string
  ID_REGEXP = /(?:<!--)?ID: (\d+)/
  formatter: FormatConverter
  curly_cloze: boolean
  highlights_to_cloze: boolean
  no_note_type: boolean

  constructor(
    note_text: string,
    fields_dict: FIELDS_DICT,
    curly_cloze: boolean,
    highlights_to_cloze: boolean,
    formatter: FormatConverter
  ) {
    this.text = note_text.trim()
    this.current_field_num = 0
    this.delete = false
    this.no_note_type = false
    this.split_text = this.getSplitText()
    this.identifier = this.getIdentifier()
    this.tags = this.getTags()
    this.note_type = this.getNoteType()
    if (!fields_dict.hasOwnProperty(this.note_type)) {
      this.no_note_type = true
      return
    }
    this.field_names = fields_dict[this.note_type]
    this.current_field = this.field_names[0]
    this.formatter = formatter
    this.curly_cloze = curly_cloze
    this.highlights_to_cloze = highlights_to_cloze
  }

  abstract getSplitText(): string[]
  abstract getIdentifier(): number | null
  abstract getTags(): string[]
  abstract getNoteType(): string
  abstract getFields(): Record<string, string>

  parse(
    deck: string,
    url: string,
    frozen_fields_dict: FROZEN_FIELDS_DICT,
    data: FileData,
    context: string
  ): AnkiConnectNoteAndID {
    // TODO: Fix this kind of deep cloning
    const template = JSON.parse(JSON.stringify(data.template))
    console.log('1', template)
    console.log('2', {
      modelName: this.note_type,
      fields: this.getFields(),
      tags: [...data.template.tags, ...this.tags],
      deckName: deck,
      options: data.template.options,
    })
    template.modelName = this.note_type
    if (this.no_note_type) return { note: template, identifier: NOTE_TYPE_ERROR }
    template.fields = this.getFields()
    const file_link_fields = data.file_link_fields
    if (url) this.formatter.format_note_with_url(template, url, file_link_fields[this.note_type])
    if (Object.keys(frozen_fields_dict).length)
      this.formatter.format_note_with_frozen_fields(template, frozen_fields_dict)
    if (context) {
      const context_field = data.context_fields[this.note_type]
      template['fields'][context_field] += context
    }
    if (data.add_obs_tags) {
      for (const key in template['fields']) {
        for (const match of template['fields'][key].matchAll(OBS_TAG_REGEXP)) {
          this.tags.push(match[1])
        }
        template['fields'][key] = template['fields'][key].replace(OBS_TAG_REGEXP, '')
      }
    }
    template['tags'].push(...this.tags)
    template['deckName'] = deck

    if (template.modelName === 'Cloze' && !containsCloze(template)) {
      // Error code prevents addition
      this.identifier = CLOZE_ERROR
      console.warn(`Non-clozed "Cloze" note in "${template.deckName}" deck`, template.fields)
    }
    return { note: template, identifier: this.identifier }
  }
}

export class Note extends AbstractNote {
  getSplitText(): string[] {
    return this.text.split('\n')
  }

  getIdentifier(): number | null {
    if (this.ID_REGEXP.test(this.split_text[this.split_text.length - 1])) {
      return parseInt(this.ID_REGEXP.exec(this.split_text.pop())[1])
    } else {
      return null
    }
  }

  getTags(): string[] {
    if (this.split_text[this.split_text.length - 1].startsWith(TAG_PREFIX)) {
      return this.split_text.pop().slice(TAG_PREFIX.length).split(TAG_SEP)
    } else {
      return []
    }
  }

  getNoteType(): string {
    return this.split_text[0]
  }

  fieldFromLine(line: string): [string, string] {
    /*From a given line, determine the next field to add text into.

        Then, return the stripped line, and the field.*/
    for (const field of this.field_names) {
      if (line.startsWith(field + ':')) {
        return [line.slice((field + ':').length), field]
      }
    }
    return [line, this.current_field]
  }

  getFields(): Record<string, string> {
    const fields: Record<string, string> = {}
    for (const field of this.field_names) {
      fields[field] = ''
    }
    for (let line of this.split_text.slice(1)) {
      ;[line, this.current_field] = this.fieldFromLine(line)
      fields[this.current_field] += line + '\n'
    }
    for (const key in fields) {
      fields[key] = this.formatter
        .format(
          fields[key].trim(),
          this.note_type.includes('Cloze') && this.curly_cloze,
          this.highlights_to_cloze
        )
        .trim()
    }
    return fields
  }
}

export class InlineNote extends AbstractNote {
  static TAG_REGEXP = /Tags: (.*)/
  static ID_REGEXP = /(?:<!--)?ID: (\d+)/
  static TYPE_REGEXP = /\[(.*?)\]/

  getSplitText(): string[] {
    return this.text.split(' ')
  }

  getIdentifier(): number | null {
    const result = this.text.match(InlineNote.ID_REGEXP)
    if (result) {
      this.text = this.text.slice(0, result.index).trim()
      return parseInt(result[1])
    } else {
      return null
    }
  }

  getTags(): string[] {
    const result = this.text.match(InlineNote.TAG_REGEXP)
    if (result) {
      this.text = this.text.slice(0, result.index).trim()
      return result[1].split(TAG_SEP)
    } else {
      return []
    }
  }

  getNoteType(): string {
    const result = this.text.match(InlineNote.TYPE_REGEXP)
    this.text = this.text.slice(result.index + result[0].length)
    return result[1]
  }

  getFields(): Record<string, string> {
    const fields: Record<string, string> = {}
    for (const field of this.field_names) {
      fields[field] = ''
    }
    for (let word of this.text.split(' ')) {
      for (const field of this.field_names) {
        if (word === field + ':') {
          this.current_field = field
          word = ''
        }
      }
      fields[this.current_field] += word + ' '
    }
    for (const key in fields) {
      fields[key] = this.formatter
        .format(
          fields[key].trim(),
          this.note_type.includes('Cloze') && this.curly_cloze,
          this.highlights_to_cloze
        )
        .trim()
    }
    return fields
  }
}

export class RegexNote {
  match: RegExpMatchArray
  note_type: string
  groups: Array<string>
  identifier: number | null
  tags: string[]
  field_names: string[]
  curly_cloze: boolean
  highlights_to_cloze: boolean
  formatter: FormatConverter

  constructor(
    match: RegExpMatchArray,
    note_type: string,
    fields_dict: FIELDS_DICT,
    tags: boolean,
    id: boolean,
    curly_cloze: boolean,
    highlights_to_cloze: boolean,
    formatter: FormatConverter
  ) {
    this.match = match
    this.note_type = note_type
    this.identifier = id ? parseInt(this.match.pop()) : null
    this.tags = tags ? this.match.pop().slice(TAG_PREFIX.length).split(TAG_SEP) : []
    this.field_names = fields_dict[note_type]
    this.curly_cloze = curly_cloze
    this.formatter = formatter
    this.highlights_to_cloze = highlights_to_cloze
  }

  getFields(): Record<string, string> {
    const fields: Record<string, string> = {}
    for (const field of this.field_names) {
      fields[field] = ''
    }
    for (const index in this.match.slice(1)) {
      fields[this.field_names[index]] = this.match.slice(1)[index] ? this.match.slice(1)[index] : ''
    }
    for (const key in fields) {
      fields[key] = this.formatter
        .format(
          fields[key].trim(),
          this.note_type.includes('Cloze') && this.curly_cloze,
          this.highlights_to_cloze
        )
        .trim()
    }
    return fields
  }

  parse(
    deck: string,
    url = '',
    frozen_fields_dict: FROZEN_FIELDS_DICT,
    data: FileData,
    context: string
  ): AnkiConnectNoteAndID {
    const template = JSON.parse(JSON.stringify(data.template))
    template['modelName'] = this.note_type
    template['fields'] = this.getFields()
    const file_link_fields = data.file_link_fields
    if (url) {
      this.formatter.format_note_with_url(template, url, file_link_fields[this.note_type])
    }
    if (Object.keys(frozen_fields_dict).length) {
      this.formatter.format_note_with_frozen_fields(template, frozen_fields_dict)
    }
    if (context) {
      const context_field = data.context_fields[this.note_type]
      template['fields'][context_field] += context
    }
    template['tags'].push(...this.tags)
    template['deckName'] = deck
    return { note: template, identifier: this.identifier }
  }
}
