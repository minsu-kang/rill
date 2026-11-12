import { Fragment } from 'react'
import { invisibleLabel, splitInvisible } from '../model/text'
import styles from './SafeText.module.css'

export function VisibleText({ text }: { text: string }) {
  return (
    <>
      {splitInvisible(text).map((part, index) =>
        part.invisible ? (
          <span key={index} className={styles.mark} data-invisible="" title={invisibleLabel(part.text)}>
            {`‹${invisibleLabel(part.text)}›`}
          </span>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  )
}

export function SafeText({ text }: { text: string }) {
  return (
    <bdi>
      <VisibleText text={text} />
    </bdi>
  )
}
