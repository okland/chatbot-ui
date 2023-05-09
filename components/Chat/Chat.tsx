import { IconClearAll, IconSettings } from '@tabler/icons-react';
import {
  MutableRefObject,
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import toast from 'react-hot-toast';

import { useTranslation } from 'next-i18next';

import { getEndpoint } from '@/utils/app/api';
import {
  saveConversation,
  saveConversations,
  updateConversation,
} from '@/utils/app/conversation';
import { throttle } from '@/utils/data/throttle';

import { ChatBody, Conversation, Message } from '@/types/chat';
import { Plugin } from '@/types/plugin';

import HomeContext from '@/pages/api/home/home.context';

import Spinner from '../Spinner';
import { ChatInput } from './ChatInput';
import { ChatLoader } from './ChatLoader';
import { ErrorMessageDiv } from './ErrorMessageDiv';
import { ModelSelect } from './ModelSelect';
import { SystemPrompt } from './SystemPrompt';
import { TemperatureSlider } from './Temperature';
import { MemoizedChatMessage } from './MemoizedChatMessage';

interface Props {
  stopConversationRef: MutableRefObject<boolean>;
}

export const Chat = memo(({ stopConversationRef }: Props) => {
  const { t } = useTranslation('chat');

  const {
    state: {
      selectedConversation,
      conversations,
      models,
      apiKey,
      pluginKeys,
      serverSideApiKeyIsSet,
      messageIsStreaming,
      modelError,
      loading,
      prompts,
    },
    handleUpdateConversation,
    dispatch: homeDispatch,
  } = useContext(HomeContext);

  const [currentMessage, setCurrentMessage] = useState<Message>();
  const [autoScrollEnabled, setAutoScrollEnabled] = useState<boolean>(true);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [showScrollDownButton, setShowScrollDownButton] =
    useState<boolean>(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(
    async (message: Message, deleteCount = 0, plugin: Plugin | null = null) => {
      if (selectedConversation) {
        let updatedConversation: Conversation;
        if (deleteCount) {
          const updatedMessages = [...selectedConversation.messages];
          for (let i = 0; i < deleteCount; i++) {
            updatedMessages.pop();
          }
          updatedConversation = {
            ...selectedConversation,
            messages: [...updatedMessages, message],
          };
        } else {
          updatedConversation = {
            ...selectedConversation,
            messages: [...selectedConversation.messages, message],
          };
        }
        homeDispatch({
          field: 'selectedConversation',
          value: updatedConversation,
        });
        homeDispatch({ field: 'loading', value: true });
        homeDispatch({ field: 'messageIsStreaming', value: true });
        const chatBody: ChatBody = {
          model: updatedConversation.model,
          messages: updatedConversation.messages,
          key: apiKey,
          prompt: updatedConversation.prompt,
          temperature: updatedConversation.temperature,
        };
        const endpoint = getEndpoint(plugin);
        let body;
        if (!plugin) {
          body = JSON.stringify(chatBody);
        } else {
          body = JSON.stringify({
            ...chatBody,
            googleAPIKey: pluginKeys
              .find((key) => key.pluginId === 'google-search')
              ?.requiredKeys.find((key) => key.key === 'GOOGLE_API_KEY')?.value,
            googleCSEId: pluginKeys
              .find((key) => key.pluginId === 'google-search')
              ?.requiredKeys.find((key) => key.key === 'GOOGLE_CSE_ID')?.value,
          });
        }
        const controller = new AbortController();
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
          body,
        });
        if (!response.ok) {
          homeDispatch({ field: 'loading', value: false });
          homeDispatch({ field: 'messageIsStreaming', value: false });
          toast.error(response.statusText);
          return;
        }
        const data = response.body;
        if (!data) {
          homeDispatch({ field: 'loading', value: false });
          homeDispatch({ field: 'messageIsStreaming', value: false });
          return;
        }
        if (!plugin) {
          if (updatedConversation.messages.length === 1) {
            const { content } = message;
            const customName =
              content.length > 30 ? content.substring(0, 30) + '...' : content;
            updatedConversation = {
              ...updatedConversation,
              name: customName,
            };
          }
          homeDispatch({ field: 'loading', value: false });
          const reader = data.getReader();
          const decoder = new TextDecoder();
          let done = false;
          let isFirst = true;
          let text = '';
          while (!done) {
            if (stopConversationRef.current === true) {
              controller.abort();
              done = true;
              break;
            }
            const { value, done: doneReading } = await reader.read();
            done = doneReading;
            const chunkValue = decoder.decode(value);
            text += chunkValue;
            if (isFirst) {
              isFirst = false;
              const updatedMessages: Message[] = [
                ...updatedConversation.messages,
                { role: 'assistant', content: chunkValue },
              ];
              updatedConversation = {
                ...updatedConversation,
                messages: updatedMessages,
              };
              homeDispatch({
                field: 'selectedConversation',
                value: updatedConversation,
              });
            } else {
              const updatedMessages: Message[] =
                updatedConversation.messages.map((message, index) => {
                  if (index === updatedConversation.messages.length - 1) {
                    return {
                      ...message,
                      content: text,
                    };
                  }
                  return message;
                });
              updatedConversation = {
                ...updatedConversation,
                messages: updatedMessages,
              };
              homeDispatch({
                field: 'selectedConversation',
                value: updatedConversation,
              });
            }
          }
          saveConversation(updatedConversation);
          const updatedConversations: Conversation[] = conversations.map(
            (conversation) => {
              if (conversation.id === selectedConversation.id) {
                return updatedConversation;
              }
              return conversation;
            },
          );
          if (updatedConversations.length === 0) {
            updatedConversations.push(updatedConversation);
          }
          homeDispatch({ field: 'conversations', value: updatedConversations });
          saveConversations(updatedConversations);
          homeDispatch({ field: 'messageIsStreaming', value: false });
        } else {
          const { answer } = await response.json();
          const updatedMessages: Message[] = [
            ...updatedConversation.messages,
            { role: 'assistant', content: answer },
          ];
          updatedConversation = {
            ...updatedConversation,
            messages: updatedMessages,
          };
          homeDispatch({
            field: 'selectedConversation',
            value: updateConversation,
          });
          saveConversation(updatedConversation);
          const updatedConversations: Conversation[] = conversations.map(
            (conversation) => {
              if (conversation.id === selectedConversation.id) {
                return updatedConversation;
              }
              return conversation;
            },
          );
          if (updatedConversations.length === 0) {
            updatedConversations.push(updatedConversation);
          }
          homeDispatch({ field: 'conversations', value: updatedConversations });
          saveConversations(updatedConversations);
          homeDispatch({ field: 'loading', value: false });
          homeDispatch({ field: 'messageIsStreaming', value: false });
        }
      }
    },
    [
      apiKey,
      conversations,
      pluginKeys,
      selectedConversation,
      stopConversationRef,
    ],
  );

  const scrollToBottom = useCallback(() => {
    if (autoScrollEnabled) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      textareaRef.current?.focus();
    }
  }, [autoScrollEnabled]);

  const handleScroll = () => {
    if (chatContainerRef.current) {
      const { scrollTop, scrollHeight, clientHeight } =
        chatContainerRef.current;
      const bottomTolerance = 30;

      if (scrollTop + clientHeight < scrollHeight - bottomTolerance) {
        setAutoScrollEnabled(false);
        setShowScrollDownButton(true);
      } else {
        setAutoScrollEnabled(true);
        setShowScrollDownButton(false);
      }
    }
  };

  const handleScrollDown = () => {
    chatContainerRef.current?.scrollTo({
      top: chatContainerRef.current.scrollHeight,
      behavior: 'smooth',
    });
  };

  const handleSettings = () => {
    setShowSettings(!showSettings);
  };

  const onClearAll = () => {
    if (
      confirm(t<string>('Are you sure you want to clear all messages?')) &&
      selectedConversation
    ) {
      handleUpdateConversation(selectedConversation, {
        key: 'messages',
        value: [],
      });
    }
  };

  const scrollDown = () => {
    if (autoScrollEnabled) {
      messagesEndRef.current?.scrollIntoView(true);
    }
  };
  const throttledScrollDown = throttle(scrollDown, 250);

  // useEffect(() => {
  //   console.log('currentMessage', currentMessage);
  //   if (currentMessage) {
  //     handleSend(currentMessage);
  //     homeDispatch({ field: 'currentMessage', value: undefined });
  //   }
  // }, [currentMessage]);

  useEffect(() => {
    throttledScrollDown();
    selectedConversation &&
      setCurrentMessage(
        selectedConversation.messages[selectedConversation.messages.length - 2],
      );
  }, [selectedConversation, throttledScrollDown]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        setAutoScrollEnabled(entry.isIntersecting);
        if (entry.isIntersecting) {
          textareaRef.current?.focus();
        }
      },
      {
        root: null,
        threshold: 0.5,
      },
    );
    const messagesEndElement = messagesEndRef.current;
    if (messagesEndElement) {
      observer.observe(messagesEndElement);
    }
    return () => {
      if (messagesEndElement) {
        observer.unobserve(messagesEndElement);
      }
    };
  }, [messagesEndRef]);

  return (
    <div className="relative flex-1 overflow-hidden bg-white dark:bg-[#343541]">
      {!(apiKey || serverSideApiKeyIsSet) ? (
        <div className="mx-auto flex h-full w-[300px] flex-col justify-center space-y-6 sm:w-[600px]">
          <div className="text-center text-4xl font-bold text-black dark:text-white">
            Welcome to Chatbot UI
          </div>
          <div className="text-center text-lg text-black dark:text-white">
            <div className="mb-8">{`Chatbot UI is an open source clone of OpenAI's ChatGPT UI.`}</div>
            <div className="mb-2 font-bold">
              Important: Chatbot UI is 100% unaffiliated with OpenAI.
            </div>
          </div>
          <div className="text-center text-gray-500 dark:text-gray-400">
            <div className="mb-2">
              Chatbot UI allows you to plug in your API key to use this UI with
              their API.
            </div>
            <div className="mb-2">
              It is <span className="italic">only</span> used to communicate
              with their API.
            </div>
            <div className="mb-2">
              {t(
                'Please set your OpenAI API key in the bottom left of the sidebar.',
              )}
            </div>
            <div>
              {t("If you don't have an OpenAI API key, you can get one here: ")}
              <a
                href="https://platform.openai.com/account/api-keys"
                target="_blank"
                rel="noreferrer"
                className="text-blue-500 hover:underline"
              >
                openai.com
              </a>
            </div>
          </div>
        </div>
      ) : modelError ? (
        <ErrorMessageDiv error={modelError} />
      ) : (
        <>
          <div
            className="max-h-full overflow-x-hidden"
            ref={chatContainerRef}
            onScroll={handleScroll}
          >
            {selectedConversation?.messages.length === 0 ? (
              <>
                <div className="mx-auto flex flex-col space-y-5 md:space-y-10 px-3 pt-5 md:pt-12 sm:max-w-[600px]">
                  <div className="text-center text-3xl font-semibold text-gray-800 dark:text-gray-100">
                    {models.length === 0 ? (
                      <div>
                        <Spinner size="16px" className="mx-auto" />
                      </div>
                    ) : (
                        <svg width="100" height="30" viewBox="0 0 100 28" fill="none" xmlns="http://www.w3.org/2000/svg" display="flex" cursor="pointer"><g clip-path="url(#clip0_1205_58276)"><path d="M52.421 14.0766V24.5739H47.9864V21.7782C46.3582 23.8777 43.8303 25.1952 40.9917 25.1952C34.6933 25.1952 29.5625 20.2143 29.5625 14.0766C29.5625 7.93888 34.6933 2.95801 40.9917 2.95801C47.333 2.95801 52.421 7.93888 52.421 14.0766ZM47.9114 14.0766C47.9114 10.2633 44.8372 7.15694 41.0667 7.15694C37.2962 7.15694 34.222 10.2633 34.222 14.0766C34.222 17.8899 37.2962 20.9963 41.0667 20.9963C44.8372 20.9963 47.9114 17.8899 47.9114 14.0766Z" fill="black"></path><path d="M74.9372 3.5791L65.2968 24.5737H62.2654L52.625 3.5791H57.638L63.7757 17.7291L69.9242 3.5791H74.9372Z" fill="black"></path><path d="M97.9988 14.0766C97.9988 20.225 92.868 25.1952 86.5268 25.1952C80.1855 25.1952 75.0547 20.2143 75.0547 14.0766C75.0547 7.93888 80.1855 2.95801 86.5268 2.95801C92.868 2.95801 97.9988 7.93888 97.9988 14.0766ZM93.3286 14.0766C93.3286 10.2633 90.2972 7.15694 86.5268 7.15694C82.7563 7.15694 79.7249 10.2633 79.7249 14.0766C79.7249 17.8899 82.7563 20.9963 86.5268 20.9963C90.2972 20.9963 93.3286 17.8899 93.3286 14.0766Z" fill="black"></path><path d="M21.4523 9.37436C21.4416 9.18155 21.4309 8.99945 21.4095 8.80664C21.3881 8.62455 21.3666 8.44245 21.3452 8.26035C21.3024 7.99257 21.2488 7.72478 21.1738 7.47841C21.131 7.30703 21.0774 7.14635 21.0132 6.98568C20.9596 6.82501 20.8953 6.66433 20.8204 6.51437C20.7454 6.36441 20.6704 6.21445 20.5847 6.0752C20.5419 6.00022 20.499 5.93595 20.4562 5.86097C20.3705 5.72172 20.2741 5.59318 20.167 5.46464C20.0598 5.3361 19.9527 5.21827 19.8349 5.10045C19.7706 5.03618 19.7064 4.97191 19.6314 4.91835C19.61 4.89693 19.5885 4.8755 19.5671 4.86479C19.5243 4.82195 19.4707 4.78981 19.4279 4.74697C19.3957 4.72554 19.3743 4.70412 19.3422 4.6827C19.2993 4.65056 19.2458 4.61843 19.2029 4.57558C19.1708 4.55416 19.1494 4.53273 19.1172 4.51131C19.0637 4.47918 19.0101 4.44704 18.9673 4.41491C18.9458 4.4042 18.9137 4.38277 18.8816 4.36135C18.8066 4.3185 18.7316 4.27566 18.6566 4.23281C18.6459 4.2221 18.6245 4.2221 18.6138 4.21139C18.5388 4.17925 18.4638 4.13641 18.3995 4.10427C18.3674 4.09356 18.3353 4.07214 18.3031 4.06143C18.2496 4.04 18.196 4.01858 18.1425 3.99716C18.1103 3.98645 18.0675 3.96502 18.0354 3.95431C17.9818 3.93289 17.9282 3.91146 17.8747 3.90075C17.8318 3.89004 17.7997 3.87933 17.7569 3.86862C17.7033 3.84719 17.639 3.83648 17.5855 3.81506C17.5533 3.80435 17.5105 3.79364 17.4784 3.78293C17.3927 3.7615 17.307 3.74008 17.2213 3.71866C17.1891 3.70794 17.1677 3.70794 17.1356 3.69723C17.0606 3.67581 16.9856 3.6651 16.8999 3.65439C16.8571 3.64368 16.8249 3.64368 16.7821 3.63296C16.7178 3.62225 16.6643 3.61154 16.6 3.60083C16.5679 3.60083 16.5357 3.60083 16.4929 3.59012C16.4286 3.57941 16.3751 3.57941 16.3108 3.56869C16.2679 3.56869 16.2251 3.55798 16.1823 3.55798C16.118 3.54727 16.043 3.54727 15.9787 3.53656C15.9466 3.53656 15.9038 3.52585 15.8716 3.52585C15.7645 3.51514 15.6681 3.51514 15.561 3.51514C15.5503 3.51514 15.5396 3.51514 15.5181 3.51514C15.4217 3.51514 15.3253 3.51514 15.2396 3.51514C15.2075 3.51514 15.1861 3.51514 15.1539 3.51514C15.0575 3.51514 14.9611 3.51514 14.8647 3.51514C14.8326 3.51514 14.8005 3.51514 14.7683 3.51514C14.522 3.52585 14.2649 3.54727 14.0078 3.56869C13.9757 3.56869 13.9435 3.57941 13.9114 3.57941C13.8043 3.59012 13.6865 3.60083 13.5793 3.62225C13.5579 3.62225 13.5365 3.62225 13.5151 3.63296C13.3865 3.65439 13.2473 3.6651 13.1188 3.68652C13.0973 3.68652 13.0759 3.69723 13.0545 3.69723C12.9367 3.71866 12.8295 3.74008 12.7117 3.7615C12.6903 3.7615 12.6582 3.77221 12.6367 3.77221C12.3689 3.82577 12.1012 3.87933 11.8334 3.9436C11.8119 3.95431 11.7798 3.95431 11.7584 3.96502C11.6406 3.99716 11.512 4.02929 11.3942 4.06143C11.3835 4.06143 11.3728 4.07214 11.3621 4.07214C11.2228 4.10427 11.0836 4.14712 10.9443 4.18996C10.9336 4.18996 10.9122 4.20068 10.9015 4.20068C10.7836 4.23281 10.6551 4.27566 10.5373 4.30779C10.5158 4.3185 10.4944 4.3185 10.473 4.32921C10.2052 4.41491 9.92671 4.5006 9.65892 4.597C9.6375 4.60772 9.61607 4.60772 9.59465 4.61843C9.46611 4.66127 9.34829 4.70412 9.21975 4.75768C9.20904 4.75768 9.19832 4.76839 9.18761 4.76839C9.04836 4.82195 8.91982 4.8755 8.78057 4.92906C8.76986 4.93977 8.75915 4.93977 8.73773 4.95048C8.6199 5.00404 8.50207 5.04689 8.38425 5.10045C8.36282 5.11116 8.3414 5.12187 8.31998 5.13258C8.0629 5.2397 7.80582 5.35752 7.54875 5.48606C7.52732 5.49677 7.5059 5.50749 7.48448 5.5182C7.36665 5.57175 7.25953 5.62531 7.15242 5.67887C7.14171 5.68958 7.12028 5.68958 7.10957 5.70029C6.98103 5.76456 6.86321 5.82883 6.73467 5.8931C6.72396 5.90381 6.70253 5.91452 6.69182 5.91452C6.58471 5.96808 6.47759 6.02164 6.38119 6.08591C6.35976 6.09662 6.33834 6.10733 6.30621 6.12876C6.07055 6.25729 5.84561 6.39654 5.62067 6.52508C5.59924 6.53579 5.56711 6.55722 5.54569 6.56793C5.44928 6.62149 5.35288 6.68576 5.26718 6.73931C5.24576 6.75003 5.23505 6.76074 5.21363 6.77145C5.10651 6.83572 4.9994 6.9107 4.89228 6.97497C4.87086 6.98568 4.84943 6.99639 4.83872 7.01781C4.75303 7.07137 4.66734 7.13564 4.58165 7.1892C4.56022 7.21062 4.52809 7.22133 4.50666 7.24276C4.30314 7.38201 4.12105 7.52126 3.92824 7.67122C3.90682 7.69264 3.87468 7.71407 3.85326 7.72478C3.77828 7.77833 3.7033 7.8426 3.63903 7.89616C3.61761 7.90687 3.60689 7.9283 3.58547 7.93901C3.49978 8.01399 3.41409 8.07826 3.32839 8.15324C3.30697 8.17466 3.29626 8.18537 3.27484 8.2068C3.21057 8.26035 3.1463 8.32462 3.08203 8.37818C3.0606 8.3996 3.03918 8.42103 3.01776 8.44245C2.94278 8.51743 2.8678 8.59241 2.79282 8.65668C2.55716 8.89234 2.34293 9.1387 2.13941 9.38507C1.93589 9.63143 1.74308 9.89922 1.5717 10.167C1.40031 10.4348 1.23964 10.7026 1.08968 10.9811C1.0147 11.1203 0.950429 11.2596 0.88616 11.3988C0.757621 11.6881 0.639794 11.9773 0.532679 12.2665C0.382717 12.7056 0.26489 13.1555 0.179197 13.6054C0.12564 13.9053 0.0827934 14.216 0.0506587 14.5159C0.0078125 14.9765 -0.00289905 15.4371 0.0185241 15.8977C0.0292356 16.2083 0.0613703 16.5082 0.104216 16.8189C0.147063 17.1188 0.211332 17.4294 0.286313 17.7294C0.393428 18.1793 0.54339 18.6184 0.714775 19.0576C1.18608 20.2144 1.89305 21.2856 2.82495 22.2175C2.94278 22.3353 3.0606 22.4424 3.17843 22.5603C3.21057 22.5924 3.2427 22.6138 3.27484 22.646C3.36053 22.721 3.45693 22.8066 3.54262 22.8709C3.58547 22.903 3.61761 22.9352 3.66045 22.9566C3.74614 23.0209 3.83184 23.0959 3.92824 23.1601C3.97109 23.1923 4.01393 23.2137 4.05678 23.2458C4.14247 23.3101 4.23888 23.3744 4.32457 23.4279C4.36741 23.4493 4.41026 23.4815 4.45311 23.5029C4.54951 23.5672 4.6352 23.6207 4.73161 23.6743C4.77445 23.6957 4.8173 23.7171 4.86015 23.7493C4.95655 23.8028 5.05295 23.8564 5.13865 23.9099C5.18149 23.9314 5.23505 23.9528 5.2779 23.9742C5.3743 24.017 5.4707 24.0706 5.5564 24.1135C5.60995 24.1349 5.6528 24.1563 5.70636 24.1777C5.80276 24.2206 5.88845 24.2634 5.98486 24.2955C6.03842 24.317 6.09197 24.3384 6.14553 24.3598C6.24194 24.392 6.32763 24.4348 6.42403 24.4669C6.47759 24.4884 6.53115 24.4991 6.59542 24.5205C6.68111 24.5526 6.77751 24.5848 6.86321 24.6062C6.92748 24.6276 6.98103 24.6383 7.0453 24.649C7.131 24.6705 7.2274 24.7026 7.31309 24.724C7.37736 24.7347 7.44163 24.7561 7.5059 24.7669C7.59159 24.7883 7.67728 24.8097 7.76298 24.8204C7.82725 24.8311 7.90223 24.8418 7.9665 24.8525C8.05219 24.8633 8.13788 24.8847 8.21286 24.8954C8.28784 24.9061 8.35211 24.9168 8.42709 24.9168C8.51278 24.9275 8.58777 24.9382 8.67346 24.949C8.74844 24.9597 8.82342 24.9597 8.8984 24.9597C8.97338 24.9704 9.05907 24.9704 9.13406 24.9811C9.20904 24.9811 9.28402 24.9811 9.359 24.9811C9.43398 24.9811 9.51967 24.9811 9.59465 24.9811C9.68034 24.9811 9.75533 24.9811 9.83031 24.9704C9.90529 24.9704 9.98027 24.9704 10.0552 24.9597C10.1409 24.9597 10.2159 24.949 10.3016 24.9382C10.3766 24.9382 10.4409 24.9275 10.5158 24.9275C10.6015 24.9168 10.6765 24.9061 10.7622 24.8954C10.8372 24.8847 10.9015 24.8847 10.9764 24.874C11.0621 24.8633 11.1478 24.8418 11.2335 24.8311C11.2978 24.8204 11.3621 24.8097 11.4263 24.799C11.512 24.7776 11.6084 24.7561 11.6941 24.7454C11.7584 24.7347 11.8227 24.724 11.8762 24.7026C11.9619 24.6812 12.0583 24.649 12.144 24.6276C12.1976 24.6062 12.2618 24.5955 12.3154 24.574C12.4118 24.5419 12.4975 24.5205 12.5939 24.4884C12.6474 24.4669 12.7117 24.4562 12.7653 24.4348C12.8617 24.4027 12.9474 24.3705 13.0438 24.3277C13.0973 24.3063 13.1509 24.2848 13.2044 24.2634C13.3008 24.2206 13.3973 24.1777 13.4829 24.1456C13.5365 24.1242 13.5793 24.1027 13.6329 24.0813C13.7293 24.0385 13.8257 23.9849 13.9221 23.9421C13.965 23.9206 14.0185 23.8992 14.0614 23.8778C14.1578 23.8242 14.2435 23.7707 14.3399 23.7171C14.3827 23.6957 14.4256 23.6636 14.4791 23.6421C14.5755 23.5886 14.6612 23.5243 14.7576 23.4708C14.8005 23.4386 14.8433 23.4172 14.8862 23.3851C14.9826 23.3208 15.0683 23.2565 15.1539 23.1923C15.1968 23.1601 15.2396 23.1387 15.2825 23.1066C15.3682 23.0423 15.4539 22.978 15.5396 22.903C15.5824 22.8709 15.6253 22.8388 15.6574 22.8066C15.7538 22.7317 15.8395 22.6567 15.9252 22.571C15.9573 22.5389 15.9894 22.5174 16.0216 22.4853C16.1394 22.3782 16.2572 22.2604 16.3751 22.1425C16.5464 21.9711 16.7285 21.7783 16.8999 21.5748C17.0178 21.4463 17.1356 21.307 17.2427 21.1571C17.9282 20.3001 18.5816 19.2611 19.1708 18.1257C19.2672 17.9329 19.3636 17.7508 19.46 17.5473C19.8777 16.6796 20.2526 15.7584 20.5526 14.8265C20.6597 14.5159 20.7454 14.2053 20.8418 13.8946C20.9596 13.4769 21.056 13.0591 21.1417 12.6414C21.1845 12.4379 21.2274 12.2236 21.2595 12.0201C21.281 11.913 21.2917 11.8166 21.3131 11.7095C21.4095 11.0989 21.4523 10.4884 21.4631 9.89922C21.4631 9.80282 21.4631 9.70641 21.4631 9.61001C21.4631 9.56716 21.4631 9.47076 21.4523 9.37436ZM19.6421 13.2948C18.8494 16.3154 17.1677 19.5075 15.4432 21.2428C13.8793 22.8174 11.8012 23.6743 9.58394 23.6743C7.38807 23.6743 5.32074 22.8174 3.75686 21.2749C0.521967 18.0614 0.511256 12.8235 3.72472 9.58859C4.90299 8.3996 6.77751 7.21062 8.87698 6.31085C11.105 5.35752 13.3544 4.83266 15.2182 4.83266C16.8785 4.83266 18.121 5.2397 18.9244 6.03235C20.2419 7.34987 20.5097 9.99563 19.6421 13.2948Z" fill="#49BF49"></path><path d="M18.9127 6.03221C18.1094 5.23956 16.8668 4.83252 15.2065 4.83252C13.3534 4.83252 11.0933 5.35739 8.8653 6.31071C6.77655 7.21048 4.89132 8.39947 3.71305 9.58845C0.510293 12.8233 0.521004 18.0613 3.75589 21.2748C5.31978 22.8279 7.38711 23.6741 9.58298 23.6741C11.8003 23.6741 13.8783 22.8065 15.4422 21.2426C17.1668 19.5073 18.8592 16.3153 19.6411 13.2946C20.5088 9.99549 20.241 7.34973 18.9127 6.03221ZM9.54013 20.5785C6.69086 20.5785 4.38788 18.2648 4.38788 15.4262C4.38788 12.5877 6.70157 10.274 9.54013 10.274C12.3787 10.274 14.6924 12.5877 14.6924 15.4262C14.6924 18.2648 12.3894 20.5785 9.54013 20.5785Z" fill="#BEFFBE"></path><path d="M9.54288 10.2632C6.69361 10.2632 4.39062 12.5662 4.39062 15.4154C4.39062 18.2647 6.70432 20.5677 9.54288 20.5677C12.3814 20.5677 14.6951 18.254 14.6951 15.4154C14.6951 12.5769 12.3922 10.2632 9.54288 10.2632Z" fill="#F3E2C0"></path><path d="M10.3541 16.0259C10.2792 15.9723 10.1827 15.9509 10.0863 15.9616C10.0221 15.9723 9.96852 15.9937 9.93638 16.0152C9.90425 16.0259 9.87211 16.0366 9.83998 16.0473C9.77571 16.0687 9.71144 16.0794 9.63646 16.0902C9.54005 16.1009 9.43294 16.1009 9.33653 16.0794C9.29369 16.0687 9.24013 16.058 9.19728 16.0366C9.18657 16.0366 9.17586 16.0259 9.16515 16.0259C9.1223 16.0045 9.0259 15.9402 8.88665 15.9509C8.67242 15.9723 8.51174 16.1758 8.53317 16.4115C8.58673 16.9471 9.01519 17.3541 9.51863 17.3541C10.0221 17.3541 10.4505 16.9471 10.5148 16.4115C10.5577 16.2722 10.4827 16.1116 10.3541 16.0259Z" fill="#054B32"></path><path d="M7.17596 14.0444C6.83319 14.0444 6.55469 14.3229 6.55469 14.6657C6.55469 15.0085 6.83319 15.287 7.17596 15.287C7.51873 15.287 7.79723 15.0085 7.79723 14.6657C7.79723 14.3229 7.51873 14.0444 7.17596 14.0444Z" fill="#054B32"></path><path d="M11.9103 14.0444C11.5676 14.0444 11.2891 14.3229 11.2891 14.6657C11.2891 15.0085 11.5676 15.287 11.9103 15.287C12.2531 15.287 12.5316 15.0085 12.5316 14.6657C12.5316 14.3229 12.2531 14.0444 11.9103 14.0444Z" fill="#054B32"></path></g><defs><clipPath id="clip0_1205_58276"><rect width="98" height="22.2372" fill="white" transform="translate(0 2.95801)"></rect></clipPath></defs></svg>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="sticky top-0 z-10 flex justify-center border border-b-neutral-300 bg-neutral-100 py-2 text-sm text-neutral-500 dark:border-none dark:bg-[#444654] dark:text-neutral-200">
                  {t('Model')}: {selectedConversation?.model.name} | {t('Temp')}
                  : {selectedConversation?.temperature} |
                  <button
                    className="ml-2 cursor-pointer hover:opacity-50"
                    onClick={handleSettings}
                  >
                    <IconSettings size={18} />
                  </button>
                  <button
                    className="ml-2 cursor-pointer hover:opacity-50"
                    onClick={onClearAll}
                  >
                    <IconClearAll size={18} />
                  </button>
                </div>
                {showSettings && (
                  <div className="flex flex-col space-y-10 md:mx-auto md:max-w-xl md:gap-6 md:py-3 md:pt-6 lg:max-w-2xl lg:px-0 xl:max-w-3xl">
                    <div className="flex h-full flex-col space-y-4 border-b border-neutral-200 p-4 dark:border-neutral-600 md:rounded-lg md:border">
                      <ModelSelect />
                    </div>
                  </div>
                )}

                {selectedConversation?.messages.map((message, index) => (
                  <MemoizedChatMessage
                    key={index}
                    message={message}
                    messageIndex={index}
                    onEdit={(editedMessage) => {
                      setCurrentMessage(editedMessage);
                      // discard edited message and the ones that come after then resend
                      handleSend(
                        editedMessage,
                        selectedConversation?.messages.length - index,
                      );
                    }}
                  />
                ))}

                {loading && <ChatLoader />}

                <div
                  className="h-[162px] bg-white dark:bg-[#343541]"
                  ref={messagesEndRef}
                />
              </>
            )}
          </div>

          <ChatInput
            stopConversationRef={stopConversationRef}
            textareaRef={textareaRef}
            onSend={(message, plugin) => {
              setCurrentMessage(message);
              handleSend(message, 0, plugin);
            }}
            onScrollDownClick={handleScrollDown}
            onRegenerate={() => {
              if (currentMessage) {
                handleSend(currentMessage, 2, null);
              }
            }}
            showScrollDownButton={showScrollDownButton}
          />
        </>
      )}
    </div>
  );
});
Chat.displayName = 'Chat';
