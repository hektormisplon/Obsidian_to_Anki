/*Class for managing a list of files, and their Anki requests.*/
import { ParsedSettings, FileData } from './interfaces/settings-interface'
import {
  App,
  TFile,
  TFolder,
  TAbstractFile,
  CachedMetadata,
  FileSystemAdapter,
  Notice,
} from 'obsidian'
import { AllFile } from './file'
import { getHash } from './lib/hash'
import * as AnkiConnect from './anki'
import { basename } from 'path'

interface addNoteResponse {
  result: number
  error: string | null
}

interface notesInfoResponse {
  result: Array<{
    noteId: number
    modelName: string
    tags: string[]
    fields: Record<
      string,
      {
        order: number
        value: string
      }
    >
    cards: number[]
  }>
  error: string | null
}

interface Requests1Result {
  0: {
    error: string | null
    result: Array<{
      result: addNoteResponse[]
      error: string | null
    }>
  }
  1: {
    error: string | null
    result: notesInfoResponse[]
  }
  // eslint-disable-next-line
  2: any
  // eslint-disable-next-line
  3: any
  // eslint-disable-next-line
  4: any
}

function difference<T>(setA: Set<T>, setB: Set<T>): Set<T> {
  const _difference = new Set(setA)
  for (const elem of setB) {
    _difference.delete(elem)
  }
  return _difference
}

export class FileManager {
  app: App
  data: ParsedSettings
  files: TFile[]
  ownFiles: Array<AllFile>
  file_hashes: Record<string, string>
  // eslint-disable-next-line
  requests_1_result: any
  added_media_set: Set<string>

  constructor(
    app: App,
    data: ParsedSettings,
    files: TFile[],
    file_hashes: Record<string, string>,
    added_media: string[]
  ) {
    this.app = app
    this.data = data
    this.files = files
    this.ownFiles = []
    this.file_hashes = file_hashes
    this.added_media_set = new Set(added_media)
  }

  getUrl(file: TFile): string {
    // Return link to file in Obsidian vault
    // E.g. `obsidian://open?vault=.wiki&file=wumpus.md`
    //
    // `encodeURIComponent` encodes string to URL string
    //
    // FIXME: update this to a preview that does not require Obsidian
    // E.g. to make this return a URL that serves the specified file HTML.
    // `http://localhost:8080/${encodeURIComponent(file.basename)}.html`
    return (
      'obsidian://open?vault=' +
      encodeURIComponent(this.data.vault_name) +
      String.raw`&file=` +
      encodeURIComponent(file.path)
    )
  }

  getFolderPathList(file: TFile): TFolder[] {
    const result: TFolder[] = []
    let abstractFile: TAbstractFile = file
    while (abstractFile.hasOwnProperty('parent')) {
      result.push(abstractFile.parent)
      abstractFile = abstractFile.parent
    }
    result.pop() // Removes top-level vault
    return result
  }

  getDefaultDeck(file: TFile, folder_path_list: TFolder[]): string {
    const folder_decks = this.data.folder_decks
    for (const folder of folder_path_list) {
      // Loops over them from innermost folder
      if (folder_decks[folder.path]) {
        return folder_decks[folder.path]
      }
    }
    // If no decks specified
    return this.data.template.deckName
  }

  getDefaultTags(file: TFile, folder_path_list: TFolder[]): string[] {
    const folder_tags = this.data.folder_tags
    const tags_list: string[] = []
    for (const folder of folder_path_list) {
      // Loops over them from innermost folder
      if (folder_tags[folder.path]) {
        tags_list.push(...folder_tags[folder.path].split(' '))
      }
    }
    tags_list.push(...this.data.template.tags)
    return tags_list
  }

  dataToFileData(file: TFile): FileData {
    const folder_path_list: TFolder[] = this.getFolderPathList(file)
    const result: FileData = JSON.parse(JSON.stringify(this.data))
    //Lost regexp, so have to get them back
    result.FROZEN_REGEXP = this.data.FROZEN_REGEXP
    result.DECK_REGEXP = this.data.DECK_REGEXP
    result.TAG_REGEXP = this.data.TAG_REGEXP
    result.NOTE_REGEXP = this.data.NOTE_REGEXP
    result.INLINE_REGEXP = this.data.INLINE_REGEXP
    result.EMPTY_REGEXP = this.data.EMPTY_REGEXP
    result.template.deckName = this.getDefaultDeck(file, folder_path_list)
    result.template.tags = this.getDefaultTags(file, folder_path_list)
    return result
  }

  async genAllFiles() {
    for (const file of this.files) {
      const content: string = await this.app.vault.read(file)
      const cache: CachedMetadata = this.app.metadataCache.getCache(file.path)
      const file_data = this.dataToFileData(file)
      this.ownFiles.push(
        new AllFile(
          content,
          file.path,
          // Add URL if "Add File Link" is `true`
          this.data.add_file_link ? this.getUrl(file) : '',
          file_data,
          cache
        )
      )
    }
  }

  async initialiseFiles() {
    await this.genAllFiles()
    const files_changed: Array<AllFile> = []
    const obfiles_changed: TFile[] = []
    for (const index in this.ownFiles) {
      const i = parseInt(index)
      const file = this.ownFiles[i]
      if (
        !(
          this.file_hashes.hasOwnProperty(file.path) &&
          // `file.file` contains the actual file contents
          getHash(file.file) === this.file_hashes[file.path]
        )
      ) {
        //Indicates it's changed or new
        console.info('Scanning ', file.path, "as it's changed or new.")
        file.scanFile()
        files_changed.push(file)
        obfiles_changed.push(this.files[i])
      }
    }
    this.ownFiles = files_changed
    this.files = obfiles_changed
  }

  async requests_1() {
    const actions: AnkiConnect.Request[] = [
      // Create request for adding notes
      AnkiConnect.multi(this.ownFiles.map((file) => file.getAddNotes())),
      // Create request for notes to be edited
      AnkiConnect.multi(this.ownFiles.map((file) => file.getNoteInfo())),
      // Create request for tags
      AnkiConnect.getTags(),
      // Create request for updating fields on existing notes
      AnkiConnect.multi(this.ownFiles.map((file) => file.getUpdateFields())),
      // Create request for deleting notes
      AnkiConnect.multi(this.ownFiles.map((file) => file.getDeleteNotes())),
    ]

    // FIXME: Handle in a less imperative way
    console.info('Requesting addition of media...')
    let temp: AnkiConnect.Request[] = []
    for (const { path, formatter } of this.ownFiles) {
      const mediaLinks = difference(formatter.detectedMedia, this.added_media_set)
      for (const mediaLink of mediaLinks) {
        console.log('Adding media file: ', mediaLink)
        const dataFile = this.app.metadataCache.getFirstLinkpathDest(mediaLink, path)
        if (!dataFile) {
          console.warn("Couldn't locate media file ", mediaLink)
        } else {
          // Located successfully, so treat as if we've added the media
          this.added_media_set.add(mediaLink)

          const filename = basename(mediaLink)
          const path = (this.app.vault.adapter as FileSystemAdapter).getFullPath(dataFile.path)
          // E.g.
          // {
          //   filename: "image.png",
          //   path: "/home/wiki/img/image.png"
          // }
          temp.push(AnkiConnect.storeMediaFileByPath({ filename, path }))
        }
      }
    }

    actions.push(AnkiConnect.multi(temp))
    temp = []

    // `` is a (possibly huge) object
    // (possibly consisting of lots of nested actions)
    //
    // Note: this is the only place where AnkiConnect is used to actually
    //       *write* data to Anki.
    //
    // FIXME: `request` can contain `multi` actions with an empty array of actions
    //        These should probably be either skipped or filtered out at the end
    this.requests_1_result = await AnkiConnect.invoke('multi', { actions })
    await this.parse_requests_1()
  }

  async parse_requests_1() {
    const response = this.requests_1_result as Requests1Result
    if (response[5].result.length >= 1 && response[5].result[0].error != null) {
      new Notice('Please update AnkiConnect! The way the script has added media files has changed.')
      console.warn(
        'Please update AnkiConnect! The way the script has added media files has changed.'
      )
    }
    let note_ids_array_by_file: Requests1Result[0]['result']
    try {
      note_ids_array_by_file = AnkiConnect.parse(response[0])
    } catch (error) {
      console.error('Error: ', error)
      note_ids_array_by_file = response[0].result
    }
    const note_info_array_by_file = AnkiConnect.parse(response[1])
    const tag_list: string[] = AnkiConnect.parse(response[2])
    for (const index in note_ids_array_by_file) {
      const i: number = parseInt(index)
      const file = this.ownFiles[i]
      let file_response: addNoteResponse[]
      try {
        file_response = AnkiConnect.parse(note_ids_array_by_file[i])
      } catch (error) {
        console.error('Error: ', error)
        file_response = note_ids_array_by_file[i].result
      }
      file.note_ids = []
      for (const index in file_response) {
        const i = parseInt(index)
        const response = file_response[i]
        try {
          file.note_ids.push(AnkiConnect.parse(response))
        } catch (error) {
          console.warn(
            'Failed to add note ',
            file.all_notes_to_add[i],
            ' in file',
            file.path,
            ' due to error ',
            error
          )
          file.note_ids.push(response.result)
        }
      }
    }
    for (const index in note_info_array_by_file) {
      const i: number = parseInt(index)
      const file = this.ownFiles[i]
      const file_response = AnkiConnect.parse(note_info_array_by_file[i])
      const temp: number[] = []
      for (const note_response of file_response) {
        temp.push(...note_response.cards)
      }
      file.card_ids = temp
    }
    for (const index in this.ownFiles) {
      const i: number = parseInt(index)
      const ownFile = this.ownFiles[i]
      const obFile = this.files[i]
      ownFile.tags = tag_list
      ownFile.writeIDs()
      ownFile.removeEmpties()
      if (ownFile.file !== ownFile.original_file) {
        await this.app.vault.modify(obFile, ownFile.file)
      }
    }
    await this.requests_2()
  }

  // This only gets called when a file is changed
  getHashes(): Record<string, string> {
    const result: Record<string, string> = {}
    for (const file of this.ownFiles) {
      // `file.file` contains the actual file contents
      result[file.path] = getHash(file.file)
    }
    return result
  }

  async requests_2(): Promise<void> {
    const requests: AnkiConnect.Request[] = []
    let temp: AnkiConnect.Request[] = []
    console.info('Requesting cards to be moved to target deck...')
    for (const file of this.ownFiles) {
      temp.push(file.getChangeDecks())
    }
    requests.push(AnkiConnect.multi(temp))
    temp = []
    console.info('Requesting tags to be replaced...')
    for (const file of this.ownFiles) {
      temp.push(file.getClearTags())
    }
    requests.push(AnkiConnect.multi(temp))
    temp = []
    for (const file of this.ownFiles) {
      temp.push(file.getAddTags())
    }
    requests.push(AnkiConnect.multi(temp))
    temp = []
    await AnkiConnect.invoke('multi', { actions: requests })
    console.info('All done!')
  }
}
