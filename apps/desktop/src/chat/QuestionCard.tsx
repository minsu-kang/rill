import type { PlanQuestion } from '@rill/protocol'
import { useId, useState } from 'react'
import { useT } from '../i18n'
import { ClampedText } from './ClampedText'
import styles from './QuestionCard.module.css'

export interface QuestionCardProps {
  questions: readonly PlanQuestion[]
  onSubmit(answers: Record<string, string>): void
  disabled: boolean
}

const MAX_FREE_TEXT = 2000

function optionsOf(question: PlanQuestion): string[] {
  const unique = [...new Set(question.options)]
  if (unique.length === 0) return []
  return question.default !== '' && !unique.includes(question.default) ? [question.default, ...unique] : unique
}

export function QuestionCard({ questions, onSubmit, disabled }: QuestionCardProps) {
  const t = useT()
  const base = useId()
  const [answers, setAnswers] = useState<string[]>(() => questions.map((question) => question.default))
  const blank = answers.some((answer) => answer.trim() === '')

  function set(index: number, value: string): void {
    setAnswers((previous) => previous.map((answer, at) => (at === index ? value : answer)))
  }

  function submit(): void {
    if (disabled || blank) return
    const result: Record<string, string> = {}
    questions.forEach((question, index) => {
      const options = optionsOf(question)
      result[question.id] = options.length === 0 ? answers[index]!.trim() : answers[index]!
    })
    onSubmit(result)
  }

  return (
    <form
      className={styles.card}
      data-card="questions"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <h4 className={styles.heading}>{t('chat.questions.heading')}</h4>
      {questions.map((question, index) => {
        const options = optionsOf(question)
        return (
          <fieldset key={index} className={styles.question} disabled={disabled}>
            <legend className={styles.legend}>
              <ClampedText text={question.text} max={240} />
            </legend>
            {options.length === 0 ? (
              <textarea
                className={styles.text}
                aria-label={t('chat.questions.freeText')}
                rows={2}
                maxLength={MAX_FREE_TEXT}
                disabled={disabled}
                value={answers[index]}
                onChange={(event) => set(index, event.target.value)}
              />
            ) : (
              options.map((option, at) => {
                const id = `${base}-${index}-${at}`
                return (
                  <div key={at} className={styles.option}>
                    <input type="radio" id={id} name={`${base}-${index}`} checked={answers[index] === option} disabled={disabled} onChange={() => set(index, option)} />
                    <ClampedText text={option} max={160} labelFor={id} />
                    {option === question.default ? <span className={styles.mark}>{t('chat.questions.default')}</span> : null}
                  </div>
                )
              })
            )}
          </fieldset>
        )
      })}
      <div className={styles.actions}>
        <button type="submit" className={styles.submit} disabled={disabled || blank}>
          {t('chat.questions.submit')}
        </button>
        {blank && !disabled ? <span className={styles.hint}>{t('chat.questions.needAnswers')}</span> : null}
      </div>
    </form>
  )
}
