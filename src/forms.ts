import {
    DEFAULT_OPEN_SCORING,
    DEFAULT_SCORING,
    DEFAULT_TYPE,
    ROOM_TYPES,
    SCORING_MODES,
    TOURNAMENT_HOST_HANDLE,
    type RoomType,
    type ScoringMode,
} from './config.ts'
import type { RoomSettings } from './types.ts'

export type ServerOption =
    | {
          query: string
          name: string
          required: boolean
          type: 'text'
          def: string
          placeholder: string
          limit: number
          shortcuts: string[]
      }
    | {
          query: string
          name: string
          required: boolean
          type: 'select'
          def: string
          values: { name: string; title: string }[]
      }

export type ServerForm = {
    title: string
    options: ServerOption[]
}

export function roomForms(isHost: boolean): ServerForm[] {
    const typeValues: { name: RoomType; title: string }[] = isHost
        ? [
              { name: 'groupStage', title: ROOM_TYPES.groupStage },
              { name: 'final', title: ROOM_TYPES.final },
              { name: 'casualRoom', title: ROOM_TYPES.casualRoom },
              { name: 'rankedRoom', title: ROOM_TYPES.rankedRoom },
          ]
        : [
              { name: 'casualRoom', title: ROOM_TYPES.casualRoom },
              { name: 'rankedRoom', title: ROOM_TYPES.rankedRoom },
          ]

    return [
        {
            title: 'Create Room',
            options: [
                {
                    query: 'name',
                    name: 'Room Name',
                    required: false,
                    type: 'text',
                    def: '',
                    placeholder: 'Enter room name...',
                    limit: 40,
                    shortcuts: [],
                },
                {
                    query: 'type',
                    name: 'Mode',
                    required: false,
                    type: 'select',
                    def: isHost ? DEFAULT_TYPE : 'casualRoom',
                    values: typeValues,
                },
                {
                    query: 'scoring',
                    name: 'Scoring',
                    required: false,
                    type: 'select',
                    def: isHost ? DEFAULT_SCORING : DEFAULT_OPEN_SCORING,
                    values: [
                        { name: 'pp', title: SCORING_MODES.pp },
                        { name: 'rankedMatch', title: SCORING_MODES.rankedMatch },
                    ],
                },
            ],
        },
    ]
}

export function parseSettings(
    optionValues: string,
    _existing: RoomSettings | undefined,
    fallbackName: string,
    isHost = false,
): RoomSettings | null {
    const params = new URLSearchParams(optionValues)

    const rawName = (params.get('name') ?? '').trim()
    const name = rawName.slice(0, 40) || `${fallbackName}'s Room`

    const rawType = (params.get('type') ?? '').trim() as RoomType
    const allowedTypes = new Set<RoomType>(
        isHost
            ? ['groupStage', 'final', 'casualRoom', 'rankedRoom']
            : ['casualRoom', 'rankedRoom'],
    )
    const type: RoomType = allowedTypes.has(rawType)
        ? rawType
        : isHost
          ? DEFAULT_TYPE
          : 'casualRoom'

    const rawScoring = (params.get('scoring') ?? '').trim() as ScoringMode
    const allowedScoring = new Set<ScoringMode>(['pp', 'rankedMatch'])
    const scoring: ScoringMode = allowedScoring.has(rawScoring)
        ? rawScoring
        : isHost
          ? DEFAULT_SCORING
          : DEFAULT_OPEN_SCORING

    return {
        name,
        type,
        scoring,
        hostHandle: isHost ? TOURNAMENT_HOST_HANDLE : undefined,
    }
}
