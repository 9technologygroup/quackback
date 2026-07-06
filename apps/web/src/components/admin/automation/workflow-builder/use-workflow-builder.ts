/**
 * State for the fullscreen workflow builder route (support platform §4.6):
 * the editable draft (name, class, trigger, trigger settings, step graph),
 * the current selection (a node to edit, an insertion point to fill, or
 * nothing), dirty tracking, and the explicit Save / Set live / Pause actions.
 * One hook so the top bar, outline, canvas, and inspector all read and mutate
 * the same state instead of threading a dozen props between siblings.
 */
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { WorkflowDTO } from '@/lib/server/functions/workflows'
import { useUpdateWorkflow, useSetWorkflowStatus } from '@/lib/client/mutations/workflows'
import { useWorkflowEntities } from './entities'
import type { BuilderSelection } from './types'
import {
  collectStepIssues,
  createStep,
  draftIssues,
  draftToGraphJson,
  deriveOutline,
  graphToTree,
  initialGraphDraft,
  insertStepAt,
  parseWorkflowGraphText,
  removeStepById,
  treeToGraph,
  triggerLabel,
  updateStepById,
  type ActionType,
  type GraphDraft,
  type StepLocation,
  type TreeStep,
  type WorkflowClassValue,
  type WorkflowStatusValue,
} from '../workflow-graph'

/** Free-form trigger settings, with `channels` pulled out for the checkboxes
 *  (unrecognized keys, e.g. a frequency cap, round-trip untouched). */
export interface TriggerSettingsDraft {
  channels: string[]
  [key: string]: unknown
}

function toTriggerSettingsDraft(raw: Record<string, unknown>): TriggerSettingsDraft {
  const channels = Array.isArray(raw.channels)
    ? raw.channels.filter((c): c is string => typeof c === 'string')
    : []
  return { ...raw, channels }
}

export function useWorkflowBuilder(workflow: WorkflowDTO) {
  const { labels } = useWorkflowEntities()
  const updateMutation = useUpdateWorkflow()
  const statusMutation = useSetWorkflowStatus()

  const [name, setName] = useState(workflow.name)
  const [workflowClass, setWorkflowClass] = useState<WorkflowClassValue>(
    workflow.class as WorkflowClassValue
  )
  const [triggerType, setTriggerType] = useState(workflow.triggerType)
  const [triggerSettings, setTriggerSettings] = useState<TriggerSettingsDraft>(() =>
    toTriggerSettingsDraft(workflow.triggerSettings)
  )
  const [graphDraft, setGraphDraft] = useState<GraphDraft>(() => initialGraphDraft(workflow.graph))
  const [status, setLocalStatus] = useState<WorkflowStatusValue>(
    workflow.status as WorkflowStatusValue
  )
  const [dirty, setDirty] = useState(false)
  const [selection, setSelection] = useState<BuilderSelection>(null)
  const [outlineCollapsed, setOutlineCollapsed] = useState(false)
  const [toggleError, setToggleError] = useState<string | null>(null)

  const changeName = useCallback((next: string) => {
    setName(next)
    setDirty(true)
  }, [])
  const changeClass = useCallback((next: WorkflowClassValue) => {
    setWorkflowClass(next)
    setDirty(true)
  }, [])
  const changeTriggerType = useCallback((next: string) => {
    setTriggerType(next)
    setDirty(true)
  }, [])
  const changeTriggerSettings = useCallback((next: TriggerSettingsDraft) => {
    setTriggerSettings(next)
    setDirty(true)
  }, [])
  const changeGraphDraft = useCallback((next: GraphDraft) => {
    setToggleError(null)
    setGraphDraft(next)
    setDirty(true)
  }, [])

  // Visual <-> JSON toggle (same rules as the dialog editor's "Edit as JSON"):
  // JSON always renders; visual only renders when the graph is tree-shaped.
  const setEditorMode = useCallback(
    (mode: 'visual' | 'json') => {
      setSelection(null)
      if (mode === 'json') {
        if (graphDraft.mode !== 'visual') return
        changeGraphDraft({
          mode: 'json',
          text: JSON.stringify(treeToGraph(graphDraft.tree), null, 2),
        })
        return
      }
      if (graphDraft.mode !== 'json') return
      const parsed = parseWorkflowGraphText(graphDraft.text)
      if (!parsed.ok) return setToggleError(parsed.error)
      const tree = graphToTree(parsed.value)
      if (!tree.ok) {
        return setToggleError(`The visual builder needs a single tree of paths: ${tree.error}.`)
      }
      changeGraphDraft({ mode: 'visual', tree: tree.value })
    },
    [graphDraft, changeGraphDraft]
  )

  const selectNode = useCallback((id: string) => setSelection({ kind: 'node', id }), [])
  const selectInsertion = useCallback(
    (location: StepLocation, index: number) => setSelection({ kind: 'insert', location, index }),
    []
  )
  const clearSelection = useCallback(() => setSelection(null), [])

  const insertAtSelection = useCallback(
    (kind: TreeStep['kind'], actionType?: ActionType) => {
      if (graphDraft.mode !== 'visual' || selection?.kind !== 'insert') return
      const step = createStep(graphDraft.tree, kind, actionType)
      const tree = insertStepAt(graphDraft.tree, selection.location, selection.index, step)
      changeGraphDraft({ mode: 'visual', tree })
      setSelection({ kind: 'node', id: step.id })
    },
    [graphDraft, selection, changeGraphDraft]
  )

  const updateSelectedStep = useCallback(
    (updater: (step: TreeStep) => TreeStep) => {
      if (graphDraft.mode !== 'visual' || selection?.kind !== 'node') return
      changeGraphDraft({
        mode: 'visual',
        tree: updateStepById(graphDraft.tree, selection.id, updater),
      })
    },
    [graphDraft, selection, changeGraphDraft]
  )

  /** Remove any step by id (the canvas card's hover delete button); clears
   *  the selection if the removed step was selected. */
  const removeStep = useCallback(
    (id: string) => {
      if (graphDraft.mode !== 'visual') return
      changeGraphDraft({ mode: 'visual', tree: removeStepById(graphDraft.tree, id) })
      setSelection((sel) => (sel?.kind === 'node' && sel.id === id ? null : sel))
    },
    [graphDraft, changeGraphDraft]
  )

  const triggerLabelText = triggerLabel(triggerType)

  const stepIssues = useMemo(
    () =>
      graphDraft.mode === 'visual' ? collectStepIssues(graphDraft.tree) : new Map<string, string>(),
    [graphDraft]
  )
  const issues = useMemo(() => draftIssues(graphDraft), [graphDraft])
  const outline = useMemo(
    () =>
      graphDraft.mode === 'visual'
        ? deriveOutline(graphDraft.tree, triggerLabelText, stepIssues, labels)
        : [],
    [graphDraft, triggerLabelText, stepIssues, labels]
  )

  const saving = updateMutation.isPending
  const save = useCallback(() => {
    const graph = draftToGraphJson(graphDraft)
    if (!graph.ok) {
      toast.error(`The workflow could not be saved: ${graph.error}`)
      return
    }
    updateMutation.mutate(
      {
        id: workflow.id,
        name: name.trim() || workflow.name,
        class: workflowClass,
        triggerType,
        triggerSettings,
        graph: graph.value,
      },
      {
        onSuccess: () => setDirty(false),
        onError: () => toast.error('The workflow could not be saved. Try again.'),
      }
    )
  }, [
    graphDraft,
    updateMutation,
    workflow.id,
    workflow.name,
    name,
    workflowClass,
    triggerType,
    triggerSettings,
  ])

  const canGoLive = issues.blocking === null && issues.count === 0
  const setLive = useCallback(() => {
    if (!canGoLive) {
      toast.error(
        issues.blocking ??
          `Fix ${issues.count} issue${issues.count === 1 ? '' : 's'} before going live`
      )
      return
    }
    // The issues gate above judged the local draft; only the saved graph goes
    // live, so unsaved edits must land first or the gate is judging the wrong
    // thing (and the user would publish something other than what they see).
    if (dirty) {
      toast.error('Save your changes before going live')
      return
    }
    statusMutation.mutate(
      { id: workflow.id, status: 'live' },
      {
        onSuccess: () => setLocalStatus('live'),
        onError: () => toast.error('Could not update status'),
      }
    )
  }, [canGoLive, dirty, issues.blocking, issues.count, statusMutation, workflow.id])

  const pause = useCallback(() => {
    statusMutation.mutate(
      { id: workflow.id, status: 'paused' },
      {
        onSuccess: () => setLocalStatus('paused'),
        onError: () => toast.error('Could not update status'),
      }
    )
  }, [statusMutation, workflow.id])

  return {
    name,
    changeName,
    workflowClass,
    changeClass,
    triggerType,
    changeTriggerType,
    triggerSettings,
    changeTriggerSettings,
    triggerLabelText,
    graphDraft,
    changeGraphDraft,
    setEditorMode,
    toggleError,
    status,
    dirty,
    saving,
    save,
    canGoLive,
    setLive,
    pause,
    statusPending: statusMutation.isPending,
    selection,
    selectNode,
    selectInsertion,
    clearSelection,
    insertAtSelection,
    updateSelectedStep,
    removeStep,
    stepIssues,
    issues,
    outline,
    outlineCollapsed,
    toggleOutline: () => setOutlineCollapsed((c) => !c),
  }
}

export type WorkflowBuilderState = ReturnType<typeof useWorkflowBuilder>
