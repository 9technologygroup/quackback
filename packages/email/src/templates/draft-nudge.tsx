import { Button, Heading, Section, Text } from '@react-email/components'
import { EmailLayout, NotificationFooter } from './email-layout'
import { typography, button, colors } from './shared-styles'

interface DraftNudgeEmailProps {
  workspaceName: string
  logoUrl?: string
  draftTitle: string
  ctaUrl: string
}

/**
 * Gentle reminder sent to a visitor whose draft feedback post has sat
 * un-acted-on. Mirrors the chat-message envelope (logo + footer) so it reads as
 * part of the same conversation thread.
 */
export function DraftNudgeEmail({
  workspaceName,
  logoUrl,
  draftTitle,
  ctaUrl,
}: DraftNudgeEmailProps) {
  const heading = 'Finish sharing your idea'
  return (
    <EmailLayout preview={heading} logoUrl={logoUrl} logoAlt={workspaceName}>
      <Heading style={typography.h1}>{heading}</Heading>
      <Text style={typography.text}>
        You started a draft to share with {workspaceName}, but it&apos;s still waiting on you.
      </Text>

      <Section
        style={{
          backgroundColor: colors.surfaceMuted,
          borderRadius: '8px',
          padding: '16px 20px',
          marginBottom: '16px',
        }}
      >
        <Text
          style={{
            ...typography.textSmall,
            marginTop: '0',
            marginBottom: '4px',
            color: colors.textMuted,
          }}
        >
          Your draft
        </Text>
        <Text style={{ ...typography.text, marginTop: '0', marginBottom: '0', fontWeight: 600 }}>
          {draftTitle}
        </Text>
      </Section>

      <Section style={{ textAlign: 'center', marginTop: '32px', marginBottom: '32px' }}>
        <Button style={button.primary} href={ctaUrl}>
          Review &amp; publish
        </Button>
      </Section>

      <NotificationFooter
        reason="You received this email because you have an open conversation with this team."
        unsubscribeUrl={ctaUrl}
      />
    </EmailLayout>
  )
}
