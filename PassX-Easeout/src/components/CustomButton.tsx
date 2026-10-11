import React from 'react';
import { TouchableOpacity, Text, StyleSheet, GestureResponderEvent } from 'react-native';
import colors from '../constants/colors';

interface CustomButtonProps {
  title: string;
  onPress: (event: GestureResponderEvent) => void;
  outlined?: boolean; // Optional prop
}

const CustomButton: React.FC<CustomButtonProps> = ({ title, onPress, outlined }) => {
  return (
    <TouchableOpacity 
      style={[styles.button, outlined && styles.outlinedButton]} 
      onPress={onPress}
    >
      <Text style={[styles.text, outlined && styles.outlinedText]}>
        {title}
      </Text>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  button: {
    backgroundColor: colors.primary,
    paddingVertical: 15,
    borderRadius: 30,
    alignItems: 'center',
    marginVertical: 10,
    width: '100%',
  },
  outlinedButton: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
  },
  text: {
    color: colors.white,
    fontSize: 16,
    fontWeight: 'bold',
  },
  outlinedText: {
    color: colors.textDark,
  },
});

export default CustomButton;